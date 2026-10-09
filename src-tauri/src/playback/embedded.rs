//! MPV inside the app window (Windows).
//!
//! One long-lived `mpv.exe` renders into the main window (`--wid`) underneath
//! the webview, which is transparent where the video should show; the
//! frontend's controls are ordinary HTML on top. The video's place in the
//! window is set with mpv's `video-margin-ratio-*` properties, so the same
//! process serves the mini player and the full player without restarting.
//!
//! The process is driven over its JSON IPC pipe:
//! - `loadfile` switches channels in the running process, which is much
//!   faster than starting a new mpv per channel;
//! - observed properties (position, pause, tracks, cache) are collected and
//!   sent to the webview as one `player-state` event at most four times a
//!   second, or at once for discrete changes like pause or a track switch.
//!
//! Live streams keep a back buffer (`--demuxer-max-back-bytes`, on disk), so
//! the player can rewind and replay recent moments of a live channel.
//!
//! Elsewhere (Linux, macOS) embedding is not supported and playback keeps
//! using a separate mpv window (`MpvPlayer`).

use super::mpv::{get_mpv_path, MpvPlayer, PlaybackStatus};
use super::PlaybackSettings;
use crate::error::AppError;
use log::{info, warn};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Notify};

pub const STATE_EVENT: &str = "player-state";

/// Properties mirrored to the frontend.
const OBSERVED: &[&str] = &[
    "time-pos",
    "duration",
    "pause",
    "paused-for-cache",
    "cache-buffering-state",
    "volume",
    "mute",
    "track-list",
    "aid",
    "sid",
    "speed",
    "seekable",
    "demuxer-cache-state",
    "eof-reached",
    "idle-active",
    "width",
    "height",
];

/// Changes the frontend should see at once rather than on the next tick.
const URGENT: &[&str] = &[
    "pause",
    "paused-for-cache",
    "track-list",
    "aid",
    "sid",
    "idle-active",
    "eof-reached",
    "mute",
    "volume",
    "speed",
];

/// Properties the webview may set, with the range a number must fall in.
const SETTABLE: &[(&str, f64, f64)] = &[
    ("pause", 0.0, 0.0),
    ("mute", 0.0, 0.0),
    ("volume", 0.0, 130.0),
    ("speed", 0.25, 4.0),
    ("aid", 0.0, 999.0),
    ("sid", 0.0, 999.0),
    ("sub-visibility", 0.0, 0.0),
    ("sub-delay", -60.0, 60.0),
    ("audio-delay", -60.0, 60.0),
    ("sub-scale", 0.5, 3.0),
];

const SEEK_MODES: &[&str] = &[
    "relative",
    "absolute",
    "absolute-percent",
    "relative+exact",
    "absolute+exact",
];

/// Embedded-only options, read from settings next to the MPV ones.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedOptions {
    /// Back buffer for rewinding live channels, in MiB.
    pub timeshift_mb: u32,
}

impl Default for EmbedOptions {
    fn default() -> Self {
        Self { timeshift_mb: 512 }
    }
}

#[derive(Default)]
struct Shared {
    props: Map<String, Value>,
    dirty: bool,
}

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Session {
    child: Child,
    tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    /// A stream failed to open; `status()` reports it once.
    failed: Arc<AtomicBool>,
    shared: Arc<StdMutex<Shared>>,
    /// The options the process was started with; a change restarts it.
    signature: String,
    last_rect: StdMutex<Option<[i64; 4]>>,
}

impl Session {
    fn send_raw(&self, cmd: Value) {
        let _ = self.tx.send(json!({ "command": cmd }).to_string());
    }

    async fn request(&self, cmd: Value) -> Result<Value, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.tx
            .send(json!({ "command": cmd, "request_id": id }).to_string())
            .map_err(|_| AppError::Mpv("The player is not running".into()))?;
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(AppError::Mpv(e)),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err(AppError::Mpv("The player did not answer".into()))
            }
        }
    }

    fn kill(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        self.send_raw(json!(["quit"]));
        if let Ok(None) = self.child.try_wait() {
            std::thread::sleep(Duration::from_millis(150));
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.alive.load(Ordering::Relaxed) {
            self.kill();
        }
    }
}

/// The embedded player shared between commands.
#[derive(Default)]
pub struct EmbeddedPlayer {
    session: tokio::sync::Mutex<Option<Session>>,
}

/// Whether this build can embed MPV in the window.
pub const fn supported() -> bool {
    cfg!(windows)
}

fn signature(s: &PlaybackSettings, e: &EmbedOptions) -> String {
    format!(
        "{}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{}",
        s.hwdec,
        s.video_output,
        s.deinterlace,
        s.audio_lang,
        s.subtitle_lang,
        s.cache_secs,
        s.user_agent,
        s.start_volume,
        e.timeshift_mb
    )
}

/// Keeps a few cache-state fields: the full object is large and changes on
/// every packet.
fn trim_cache_state(v: Value) -> Value {
    let mut out = Map::new();
    if let Value::Object(m) = v {
        for k in [
            "seekable-ranges",
            "cache-end",
            "cache-duration",
            "reader-pts",
            "eof",
        ] {
            if let Some(x) = m.get(k) {
                out.insert(k.to_string(), x.clone());
            }
        }
    }
    Value::Object(out)
}

impl EmbeddedPlayer {
    /// Load `urls` (the first plays, the rest queue), starting or restarting
    /// the process when needed.
    pub async fn load(
        &self,
        app: &AppHandle,
        urls: &[String],
        settings: &PlaybackSettings,
        embed: &EmbedOptions,
    ) -> Result<(), AppError> {
        if urls.is_empty() {
            return Err(AppError::InvalidInput("Nothing to play".into()));
        }
        let mut guard = self.session.lock().await;
        let sig = signature(settings, embed);
        let reusable = guard
            .as_ref()
            .is_some_and(|s| s.alive.load(Ordering::Relaxed) && s.signature == sig);
        if !reusable {
            if let Some(mut old) = guard.take() {
                old.kill();
            }
            *guard = Some(start(app, settings, embed, sig).await?);
        }
        let session = guard.as_ref().unwrap();
        session.failed.store(false, Ordering::Relaxed);
        if let Some(title) = &settings.title {
            session.send_raw(json!(["set_property", "force-media-title", title]));
        }
        session.send_raw(json!(["set_property", "pause", false]));
        session
            .request(json!(["loadfile", urls[0], "replace"]))
            .await?;
        for url in &urls[1..] {
            session.send_raw(json!(["loadfile", url, "append"]));
        }
        Ok(())
    }

    /// Stop playback; the process stays, idle, for the next channel.
    pub async fn stop(&self) {
        if let Some(s) = self.session.lock().await.as_ref() {
            s.send_raw(json!(["stop"]));
        }
    }

    pub async fn is_active(&self) -> bool {
        self.session
            .lock()
            .await
            .as_ref()
            .is_some_and(|s| s.alive.load(Ordering::Relaxed))
    }

    pub async fn status(&self) -> PlaybackStatus {
        let guard = self.session.lock().await;
        let Some(s) = guard.as_ref() else {
            return PlaybackStatus {
                playing: false,
                failed: false,
            };
        };
        if s.failed.swap(false, Ordering::Relaxed) {
            return PlaybackStatus {
                playing: false,
                failed: true,
            };
        }
        let idle = s
            .shared
            .lock()
            .unwrap()
            .props
            .get("idle-active")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        PlaybackStatus {
            playing: s.alive.load(Ordering::Relaxed) && !idle,
            failed: false,
        }
    }

    /// Place the video: a rectangle in the window, as fractions of its size.
    pub async fn set_rect(&self, x: f64, y: f64, w: f64, h: f64) -> Result<(), AppError> {
        let guard = self.session.lock().await;
        let Some(s) = guard.as_ref() else {
            return Ok(());
        };
        let clamp = |v: f64| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        let (x, y, w, h) = (clamp(x), clamp(y), clamp(w), clamp(h));
        // Compared at 1/10000 so sub-pixel jitter sends nothing.
        let key = [x, y, w, h].map(|v| (v * 10_000.0).round() as i64);
        {
            let mut last = s.last_rect.lock().unwrap();
            if *last == Some(key) {
                return Ok(());
            }
            *last = Some(key);
        }
        for (name, value) in [
            ("video-margin-ratio-left", x),
            ("video-margin-ratio-top", y),
            ("video-margin-ratio-right", (1.0 - x - w).max(0.0)),
            ("video-margin-ratio-bottom", (1.0 - y - h).max(0.0)),
        ] {
            s.send_raw(json!(["set_property", name, value]));
        }
        Ok(())
    }

    pub async fn set_property(&self, name: &str, value: Value) -> Result<(), AppError> {
        let Some((_, lo, hi)) = SETTABLE.iter().find(|(n, _, _)| *n == name) else {
            return Err(AppError::InvalidInput(format!(
                "Property {name} cannot be set"
            )));
        };
        let ok = match &value {
            Value::Bool(_) => true,
            Value::Number(n) => n.as_f64().is_some_and(|f| f >= *lo && f <= *hi),
            // "no" turns subtitles off; "auto" picks the default track.
            Value::String(s) => matches!(s.as_str(), "no" | "auto" | "yes"),
            _ => false,
        };
        if !ok {
            return Err(AppError::InvalidInput(format!("Bad value for {name}")));
        }
        self.with_session(|s| s.send_raw(json!(["set_property", name, value])))
            .await
    }

    pub async fn seek(&self, value: f64, mode: &str) -> Result<(), AppError> {
        if !value.is_finite() || !SEEK_MODES.contains(&mode) {
            return Err(AppError::InvalidInput("Bad seek".into()));
        }
        self.with_session(|s| s.send_raw(json!(["seek", value, mode])))
            .await
    }

    /// One frame forward or back (pauses first, as mpv does).
    pub async fn frame_step(&self, back: bool) -> Result<(), AppError> {
        let cmd = if back {
            "frame-back-step"
        } else {
            "frame-step"
        };
        self.with_session(|s| s.send_raw(json!([cmd]))).await
    }

    pub async fn shutdown(&self) {
        if let Some(mut s) = self.session.lock().await.take() {
            s.kill();
        }
    }

    async fn with_session(&self, f: impl FnOnce(&Session)) -> Result<(), AppError> {
        match self.session.lock().await.as_ref() {
            Some(s) if s.alive.load(Ordering::Relaxed) => {
                f(s);
                Ok(())
            }
            _ => Err(AppError::Mpv("The player is not running".into())),
        }
    }
}

fn pipe_name() -> String {
    format!(r"\\.\pipe\better-iptv-mpv-{}", std::process::id())
}

#[cfg(windows)]
fn main_hwnd(app: &AppHandle) -> Result<isize, AppError> {
    use tauri::Manager;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Mpv("No main window to play in".into()))?;
    let hwnd = window.hwnd().map_err(|e| AppError::Mpv(e.to_string()))?;
    Ok(hwnd.0 as isize)
}

/// Puts mpv's video window under the webview, so the page (transparent
/// where the video shows) stays on top and receives every click.
#[cfg(windows)]
fn sink_video_window(parent: isize) {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE,
    };

    unsafe extern "system" fn visit(hwnd: HWND, _: LPARAM) -> BOOL {
        let mut buf = [0u16; 32];
        let n = GetClassNameW(hwnd, &mut buf) as usize;
        if String::from_utf16_lossy(&buf[..n]) == "mpv" {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_BOTTOM),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumChildWindows(Some(HWND(parent as *mut _)), Some(visit), LPARAM(0));
    }
}

#[cfg(windows)]
async fn connect(pipe: &str) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, AppError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    for _ in 0..60 {
        match ClientOptions::new().open(pipe) {
            Ok(client) => return Ok(client),
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    Err(AppError::Mpv(
        "MPV started but its control pipe never opened".into(),
    ))
}

#[cfg(not(windows))]
async fn start(
    _app: &AppHandle,
    _settings: &PlaybackSettings,
    _embed: &EmbedOptions,
    _signature: String,
) -> Result<Session, AppError> {
    Err(AppError::Mpv(
        "The in-app player needs Windows; use the separate window".into(),
    ))
}

#[cfg(windows)]
async fn start(
    app: &AppHandle,
    settings: &PlaybackSettings,
    embed: &EmbedOptions,
    signature: String,
) -> Result<Session, AppError> {
    use std::os::windows::process::CommandExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let hwnd = main_hwnd(app)?;
    let pipe = pipe_name();

    let mut cmd = Command::new(get_mpv_path());
    // The usual options first (decoder, output, languages, user agent);
    // the ones below override what does not fit an embedded player.
    let mut opts = settings.as_options();
    opts.start_fullscreen = false;
    opts.title = None;
    MpvPlayer::apply_args(&mut cmd, &opts);
    let cache_secs = settings.cache_secs.unwrap_or(30);
    // The high-quality profile's polar scalers and debanding cost too much
    // at full-window size here: the picture is composited under a
    // transparent webview, and on many GPUs the full player dropped frames
    // (the small mini player hid it). Cheap separable scalers look nearly
    // the same on TV streams. Later options override the profile's.
    cmd.args([
        "--scale=spline36",
        "--cscale=spline36",
        "--dscale=mitchell",
        "--deband=no",
        "--correct-downscaling=no",
        "--linear-downscaling=no",
        "--sigmoid-upscaling=no",
        "--hdr-compute-peak=no",
    ]);
    cmd.arg(format!("--wid={hwnd}"))
        .arg("--idle=yes")
        .arg("--force-window=yes")
        .arg("--keep-open=yes")
        .arg(format!("--input-ipc-server={pipe}"))
        .arg("--osc=no")
        .arg("--osd-level=0")
        .arg("--input-default-bindings=no")
        .arg("--input-vo-keyboard=no")
        .arg("--input-cursor=no")
        .arg("--cursor-autohide=no")
        .arg("--background-color=#000000")
        .arg("--cache=yes")
        .arg("--cache-on-disk=yes")
        .arg(format!("--cache-secs={cache_secs}"))
        .arg("--demuxer-max-bytes=150MiB")
        .arg(format!(
            "--demuxer-max-back-bytes={}MiB",
            embed.timeshift_mb
        ))
        .arg("--hr-seek=yes")
        // Live streams are not seekable on their own; inside the buffer they are.
        .arg("--force-seekable=yes")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let child = cmd
        .spawn()
        .map_err(|e| AppError::Mpv(format!("Failed to start MPV ({e}). Is MPV installed?")))?;
    info!("Embedded MPV started (pid {})", child.id());

    let client = connect(&pipe).await?;
    let (read_half, mut write_half) = tokio::io::split(client);

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let pending: Pending = Arc::default();
    let alive = Arc::new(AtomicBool::new(true));
    let failed = Arc::new(AtomicBool::new(false));
    let shared: Arc<StdMutex<Shared>> = Arc::default();
    let notify = Arc::new(Notify::new());

    // Writer: one JSON command per line.
    tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err()
                || write_half.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });

    // Reader: replies resolve their request, events update the mirror.
    {
        let (pending, alive, failed, shared, notify) = (
            pending.clone(),
            alive.clone(),
            failed.clone(),
            shared.clone(),
            notify.clone(),
        );
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = v.get("request_id").and_then(|x| x.as_u64()) {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let ok = v.get("error").and_then(|e| e.as_str()) == Some("success");
                        let _ = tx.send(if ok {
                            Ok(v.get("data").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(v
                                .get("error")
                                .and_then(|e| e.as_str())
                                .unwrap_or("error")
                                .to_string())
                        });
                    }
                    continue;
                }
                let urgent: bool;
                {
                    let mut s = shared.lock().unwrap();
                    match v.get("event").and_then(|e| e.as_str()) {
                        Some("property-change") => {
                            let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let data = v.get("data").cloned().unwrap_or(Value::Null);
                            let data = if name == "demuxer-cache-state" {
                                trim_cache_state(data)
                            } else {
                                data
                            };
                            urgent = URGENT.contains(&name);
                            s.props.insert(name.to_string(), data);
                        }
                        Some("start-file") => {
                            s.props.insert("loading".into(), Value::Bool(true));
                            s.props.insert("error".into(), Value::Bool(false));
                            urgent = true;
                        }
                        Some("file-loaded") | Some("playback-restart") => {
                            s.props.insert("loading".into(), Value::Bool(false));
                            urgent = true;
                        }
                        Some("end-file") => {
                            if v.get("reason").and_then(|r| r.as_str()) == Some("error") {
                                failed.store(true, Ordering::Relaxed);
                                s.props.insert("error".into(), Value::Bool(true));
                            }
                            s.props.insert("loading".into(), Value::Bool(false));
                            urgent = true;
                        }
                        _ => continue,
                    }
                    s.dirty = true;
                }
                if urgent {
                    notify.notify_one();
                }
            }
            alive.store(false, Ordering::Relaxed);
            {
                let mut s = shared.lock().unwrap();
                s.props.insert("closed".into(), Value::Bool(true));
                s.dirty = true;
            }
            notify.notify_one();
            warn!("Embedded MPV control pipe closed");
        });
    }

    // Emitter: at most four regular updates a second, urgent ones at once.
    {
        let (app, alive, shared, notify) =
            (app.clone(), alive.clone(), shared.clone(), notify.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    _ = notify.notified() => {}
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                }
                let snapshot = {
                    let mut s = shared.lock().unwrap();
                    if s.dirty {
                        s.dirty = false;
                        Some(Value::Object(s.props.clone()))
                    } else {
                        None
                    }
                };
                if let Some(snap) = snapshot {
                    let _ = app.emit(STATE_EVENT, snap);
                }
                if !alive.load(Ordering::Relaxed) {
                    break;
                }
            }
        });
    }

    // mpv creates its video window shortly after start; keep it under the
    // webview however late it appears.
    tauri::async_runtime::spawn(async move {
        for _ in 0..30 {
            sink_video_window(hwnd);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });

    let session = Session {
        child,
        tx,
        pending,
        next_id: AtomicU64::new(1),
        alive,
        failed,
        shared,
        signature,
        last_rect: StdMutex::new(None),
    };
    for (i, name) in OBSERVED.iter().enumerate() {
        session.send_raw(json!(["observe_property", i + 1, name]));
    }
    // Hidden until the page places it.
    for name in [
        "video-margin-ratio-left",
        "video-margin-ratio-top",
        "video-margin-ratio-right",
        "video-margin-ratio-bottom",
    ] {
        session.send_raw(json!(["set_property", name, 0.0]));
    }
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_state_keeps_only_what_the_timeline_reads() {
        let v = json!({
            "seekable-ranges": [{"start": 1.0, "end": 9.0}],
            "cache-end": 9.0,
            "fw-bytes": 123456,
            "total-bytes": 999
        });
        let t = trim_cache_state(v);
        assert!(t.get("seekable-ranges").is_some());
        assert!(t.get("fw-bytes").is_none());
    }

    #[test]
    fn a_settings_change_changes_the_signature() {
        let mut s = PlaybackSettings {
            title: None,
            audio_lang: None,
            subtitle_lang: None,
            hwdec: true,
            video_output: None,
            deinterlace: None,
            start_fullscreen: false,
            cache_secs: Some(30),
            start_volume: None,
            user_agent: None,
        };
        let e = EmbedOptions::default();
        let a = signature(&s, &e);
        s.title = Some("Other channel".into());
        assert_eq!(a, signature(&s, &e), "a new title must not restart mpv");
        s.hwdec = false;
        assert_ne!(a, signature(&s, &e));
    }
}
