use crate::commands::with_db;
use crate::db::queries;
use crate::error::AppError;
use crate::playback::embedded::{self, EmbedOptions};
use crate::playback::{self, PlaybackSettings};
use crate::state::{AppState, CurrentChannel};
use log::info;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

/// "embedded" (the default where supported) or "external".
pub const PLAYER_MODE_KEY: &str = "player_mode";
/// Live rewind buffer in MiB.
pub const TIMESHIFT_KEY: &str = "player_timeshift_mb";

const MPV_SETTING_KEYS: &[&str] = &[
    "audio_language",
    "subtitle_language",
    "mpv_hardware_acceleration",
    "mpv_video_output",
    "mpv_deinterlace",
    "mpv_start_fullscreen",
    "mpv_cache_secs",
    "mpv_start_volume",
    "playlist_user_agent_mode",
    "playlist_user_agent_custom",
];

/// Build playback settings from database settings
pub fn build_playback_options(
    db: &rusqlite::Connection,
    title: Option<&str>,
) -> Result<PlaybackSettings, AppError> {
    let settings = queries::get_multiple_settings(db, MPV_SETTING_KEYS)?;

    let audio_lang = settings
        .get("audio_language")
        .filter(|s| !s.is_empty())
        .cloned();
    let subtitle_lang = settings
        .get("subtitle_language")
        .filter(|s| !s.is_empty())
        .cloned();
    let hwdec = settings
        .get("mpv_hardware_acceleration")
        .map(|s| s != "false")
        .unwrap_or(true);
    let video_output = settings.get("mpv_video_output").cloned();
    let deinterlace = settings.get("mpv_deinterlace").cloned();
    let start_fullscreen = settings
        .get("mpv_start_fullscreen")
        .map(|s| s == "true")
        .unwrap_or(false);
    let cache_secs = settings
        .get("mpv_cache_secs")
        .and_then(|s| s.parse::<u32>().ok());
    let start_volume = settings
        .get("mpv_start_volume")
        .and_then(|s| s.parse::<u32>().ok());
    // The stream carries the same User-Agent as the playlist and EPG requests.
    let user_agent = crate::http::resolve_playlist_user_agent(
        settings.get("playlist_user_agent_mode").map(|s| s.as_str()),
        settings
            .get("playlist_user_agent_custom")
            .map(|s| s.as_str()),
    );

    Ok(PlaybackSettings {
        title: title.map(|s| s.to_string()),
        audio_lang,
        subtitle_lang,
        hwdec,
        video_output,
        deinterlace,
        start_fullscreen,
        cache_secs,
        start_volume,
        user_agent: Some(user_agent),
    })
}

/// The embedded player's options, or None when playback uses a separate
/// MPV window (not Windows, or the user chose it).
pub fn read_embed_options(db: &rusqlite::Connection) -> Result<Option<EmbedOptions>, AppError> {
    if !embedded::supported() {
        return Ok(None);
    }
    let settings = queries::get_multiple_settings(db, &[PLAYER_MODE_KEY, TIMESHIFT_KEY])?;
    if settings
        .get(PLAYER_MODE_KEY)
        .is_some_and(|m| m == "external")
    {
        return Ok(None);
    }
    let timeshift_mb = settings
        .get(TIMESHIFT_KEY)
        .and_then(|s| s.parse::<u32>().ok())
        .map(|mb| mb.clamp(64, 4096))
        .unwrap_or(EmbedOptions::default().timeshift_mb);
    Ok(Some(EmbedOptions { timeshift_mb }))
}

#[derive(Serialize)]
pub struct PlayerCapabilities {
    /// This build can play inside the window.
    pub embedded_supported: bool,
    /// ...and the settings say to.
    pub embedded: bool,
}

#[tauri::command]
pub async fn player_capabilities(
    state: State<'_, AppState>,
) -> Result<PlayerCapabilities, AppError> {
    let embedded = with_db(&state.pool, read_embed_options).await?.is_some();
    Ok(PlayerCapabilities {
        embedded_supported: embedded::supported(),
        embedded,
    })
}

/// Where the video shows in the window, as fractions of the window size.
#[tauri::command]
pub async fn player_set_rect(
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), AppError> {
    state.embedded.set_rect(x, y, w, h).await
}

#[tauri::command]
pub async fn player_set_property(
    state: State<'_, AppState>,
    name: String,
    value: Value,
) -> Result<(), AppError> {
    state.embedded.set_property(&name, value).await
}

/// `mode`: relative, absolute, absolute-percent, relative+exact, absolute+exact.
#[tauri::command]
pub async fn player_seek(
    state: State<'_, AppState>,
    value: f64,
    mode: String,
) -> Result<(), AppError> {
    state.embedded.seek(value, &mode).await
}

#[tauri::command]
pub async fn player_frame_step(state: State<'_, AppState>, back: bool) -> Result<(), AppError> {
    state.embedded.frame_step(back).await
}

#[tauri::command]
pub async fn check_mpv_installed() -> Result<bool, AppError> {
    playback::check_mpv_installed().await
}

#[tauri::command]
/// Plays a channel from the database. The frontend sends only the id: the
/// stream URL never leaves the backend, so the webview cannot hand MPV an
/// address of its own.
pub async fn play_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<(), AppError> {
    let (channel, settings, embed) = with_db(&state.pool, move |conn| {
        let channel = queries::get_channel_by_id(conn, channel_id)?
            .ok_or(AppError::ChannelNotFound(channel_id))?;
        let settings = build_playback_options(conn, Some(&channel.name))?;
        let embed = read_embed_options(conn)?;
        Ok((channel, settings, embed))
    })
    .await?;

    playback::play_urls(&app, &state, vec![channel.url.clone()], settings, embed).await?;

    *state.current_channel.write().await = Some(CurrentChannel::from_channel(&channel));

    info!(
        "Playing channel: {} ({})",
        channel.name, channel.content_type
    );

    Ok(())
}

#[tauri::command]
pub async fn stop_playback(state: State<'_, AppState>) -> Result<(), AppError> {
    playback::stop(state.mpv_player.clone()).await?;
    state.embedded.stop().await;

    *state.current_channel.write().await = None;

    info!("Playback stopped");

    Ok(())
}

/// Whether MPV is still playing, and whether it stopped because the stream failed.
#[tauri::command]
pub async fn playback_status(
    state: State<'_, AppState>,
) -> Result<playback::mpv::PlaybackStatus, AppError> {
    if state.embedded.is_active().await {
        let embedded = state.embedded.status().await;
        if embedded.playing || embedded.failed {
            return Ok(embedded);
        }
    }
    playback::status(state.mpv_player.clone()).await
}
