//! Live sports data from Highlightly (https://highlightly.net).
//!
//! The BASIC plan allows 100 requests a day, so everything here is built to
//! spend as few as possible:
//!
//! - Every answer is cached in SQLite (`sports_cache`) with a lifetime that
//!   fits it: a finished match for a day, a live one for under a minute.
//!   Restarting the app costs nothing.
//! - Finding the match behind a programme tries the exact home team name
//!   first (one request), and only then pages through the day's fixtures,
//!   stopping at the first page that holds the match. Fetched pages are kept,
//!   so later lookups that day resume instead of starting over.
//! - Paging stops while `RESERVE` requests are left, so live updates of a
//!   match being watched keep working at the end of a busy day.
//! - The quota is read from the response headers and shown in the app.
//!
//! Nothing here runs in the background: requests happen when the user opens
//! a match or plays a channel showing one.

use crate::db::{mutations, queries};
use crate::error::AppError;
use log::{debug, warn};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicI64, Ordering};

pub const API_KEY_SETTING: &str = "highlightly_api_key";
const BASE_URL: &str = "https://sports.highlightly.net";
/// Requests kept back from fixture paging for live updates.
const RESERVE: i64 = 10;
/// Fixture pages fetched per lookup at most (100 matches each).
const MAX_PAGES_PER_LOOKUP: u32 = 6;
const PAGE_SIZE: u32 = 100;

/// Sports the API serves, as they appear in its paths.
pub const SPORTS: &[&str] = &[
    "football",
    "american-football",
    "basketball",
    "hockey",
    "baseball",
    "rugby",
    "handball",
    "volleyball",
    "cricket",
    "nba",
    "nhl",
];

/// Requests left today and the daily limit, from the last response's headers.
#[derive(Default)]
pub struct Quota {
    pub remaining: AtomicI64,
    pub limit: AtomicI64,
}

impl Quota {
    pub fn new() -> Self {
        Self {
            remaining: AtomicI64::new(-1),
            limit: AtomicI64::new(-1),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaInfo {
    pub has_key: bool,
    /// -1 until a request this session reported it.
    pub remaining: i64,
    pub limit: i64,
}

pub fn ensure_cache_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sports_cache (
            key TEXT PRIMARY KEY,
            body TEXT NOT NULL,
            fetched_at INTEGER NOT NULL
        )",
        [],
    )?;
    // Entries older than two days are never read again.
    conn.execute(
        "DELETE FROM sports_cache WHERE fetched_at < ?1",
        [chrono::Utc::now().timestamp() - 2 * 86_400],
    )?;
    Ok(())
}

fn cache_get(conn: &Connection, key: &str, max_age_secs: i64) -> Result<Option<Value>, AppError> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT body, fetched_at FROM sports_cache WHERE key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(row.and_then(|(body, at)| {
        if chrono::Utc::now().timestamp() - at <= max_age_secs {
            serde_json::from_str(&body).ok()
        } else {
            None
        }
    }))
}

fn cache_put(conn: &Connection, key: &str, body: &Value) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO sports_cache (key, body, fetched_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
        rusqlite::params![key, body.to_string(), chrono::Utc::now().timestamp()],
    )
    .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

pub fn api_key(conn: &Connection) -> Result<Option<String>, AppError> {
    Ok(queries::get_setting(conn, API_KEY_SETTING)?
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty()))
}

pub fn store_api_key(conn: &Connection, key: &str) -> Result<(), AppError> {
    mutations::set_setting(conn, API_KEY_SETTING, key.trim())?;
    Ok(())
}

pub fn validate_sport(sport: &str) -> Result<&'static str, AppError> {
    SPORTS
        .iter()
        .find(|s| **s == sport)
        .copied()
        .ok_or_else(|| AppError::InvalidInput(format!("Unsupported sport: {sport}")))
}

/// One GET against the API. Records the quota headers either way.
pub async fn fetch(key: &str, path_and_query: &str, quota: &Quota) -> Result<Value, AppError> {
    let url = format!("{BASE_URL}{path_and_query}");
    debug!("Highlightly GET {path_and_query}");
    let response = crate::http::get_http_client()
        .get(&url)
        .header("x-rapidapi-key", key)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| AppError::Http(format!("Could not reach Highlightly: {e}")))?;

    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
    };
    if let Some(left) = header("x-ratelimit-requests-remaining") {
        quota.remaining.store(left, Ordering::Relaxed);
    }
    if let Some(limit) = header("x-ratelimit-requests-limit") {
        quota.limit.store(limit, Ordering::Relaxed);
    }

    let status = response.status();
    if status.as_u16() == 429 {
        quota.remaining.store(0, Ordering::Relaxed);
        return Err(AppError::Http(
            "Today's Highlightly request quota is used up; it resets tomorrow".into(),
        ));
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(AppError::Http(
            "Highlightly refused the API key. Check it under Display → Sports".into(),
        ));
    }
    if !status.is_success() {
        return Err(AppError::Http(format!("Highlightly answered {status}")));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| AppError::Parse(format!("Unreadable Highlightly answer: {e}")))
}

// ---------- Team name matching ----------

/// Words that carry no identity in a team name.
const NOISE: &[&str] = &[
    "fc", "cf", "sc", "afc", "ac", "as", "ss", "sk", "fk", "bk", "if", "club", "de", "the", "cd",
    "ud", "sd", "rc", "real", "u21", "u23", "women", "w", "fem",
];

/// Common short forms in guide titles, expanded before comparing.
const ALIASES: &[(&str, &str)] = &[
    ("man utd", "manchester united"),
    ("man united", "manchester united"),
    ("man city", "manchester city"),
    ("spurs", "tottenham"),
    ("wolves", "wolverhampton"),
    ("psg", "paris saint germain"),
    ("inter", "inter milan"),
    ("atletico", "atletico madrid"),
    ("atleti", "atletico madrid"),
    ("barca", "barcelona"),
    ("bayern", "bayern munich"),
    ("bvb", "borussia dortmund"),
    ("dortmund", "borussia dortmund"),
    ("gladbach", "borussia monchengladbach"),
    ("leverkusen", "bayer leverkusen"),
    ("nottm forest", "nottingham forest"),
    ("forest", "nottingham forest"),
    ("newcastle", "newcastle united"),
    ("west ham", "west ham united"),
    ("brighton", "brighton hove albion"),
    ("sheff utd", "sheffield united"),
    ("sheff wed", "sheffield wednesday"),
    ("qpr", "queens park rangers"),
    ("wba", "west bromwich albion"),
];

fn fold(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ß' => 's',
        _ => c,
    }
}

/// Lower-case, accent-free words of a team name, aliases expanded and noise dropped.
pub fn team_tokens(name: &str) -> Vec<String> {
    tokens(name, true)
}

fn tokens(name: &str, expand: bool) -> Vec<String> {
    let mut s: String = name
        .to_lowercase()
        .chars()
        .map(fold)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    for (short, long) in ALIASES.iter().filter(|_| expand) {
        if s == *short || s.starts_with(&format!("{short} ")) {
            s = s.replacen(short, long, 1);
            break;
        }
    }
    s.split_whitespace()
        .filter(|w| !NOISE.contains(w))
        .map(|w| w.to_string())
        .collect()
}

/// How alike two team names are, 0.0 to 1.0. A word counts when the other
/// name has it, or (three letters or more) a word starting with it, so
/// "Utd" and "United" or "Man" and "Manchester" meet.
///
/// Names are compared with and without alias expansion and the closer
/// reading wins: "Bayern" expands to "Bayern Munich", which would otherwise
/// miss the API's "Bayern München".
pub fn team_similarity(a: &str, b: &str) -> f64 {
    let mut best: f64 = 0.0;
    for ea in [true, false] {
        for eb in [true, false] {
            best = best.max(similarity_of(&tokens(a, ea), &tokens(b, eb)));
        }
    }
    best
}

fn similarity_of(ta: &[String], tb: &[String]) -> f64 {
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    if ta == tb {
        return 1.0;
    }
    let hits = |xs: &[String], ys: &[String]| {
        xs.iter()
            .filter(|x| {
                ys.iter().any(|y| {
                    x == &y
                        || (x.len() >= 3 && y.starts_with(x.as_str()))
                        || (y.len() >= 3 && x.starts_with(y.as_str()))
                })
            })
            .count() as f64
    };
    // The shorter name must be covered; the longer one may have extra words.
    let (short, long) = if ta.len() <= tb.len() {
        (ta, tb)
    } else {
        (tb, ta)
    };
    let cover = hits(short, long) / short.len() as f64;
    let spill = hits(long, short) / long.len() as f64;
    cover * 0.8 + spill * 0.2
}

/// The fixture that best fits "home v away", either way round, if any fits well.
pub fn best_match<'a>(fixtures: &'a [Value], home: &str, away: &str) -> Option<&'a Value> {
    let name = |m: &Value, side: &str| {
        m.get(side)
            .and_then(|t| t.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string()
    };
    let mut best: Option<(&Value, f64)> = None;
    for m in fixtures {
        let (h, a) = (name(m, "homeTeam"), name(m, "awayTeam"));
        let straight = team_similarity(home, &h).min(team_similarity(away, &a));
        let swapped = team_similarity(home, &a).min(team_similarity(away, &h)) * 0.95;
        let score = straight.max(swapped);
        if score >= 0.6 && best.is_none_or(|(_, s)| score > s) {
            best = Some((m, score));
        }
    }
    best.map(|(m, _)| m)
}

/// The cached fixture pages of one sport and day.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DayFixtures {
    pub matches: Vec<Value>,
    /// Total fixtures the API reported, once known.
    pub total: Option<u64>,
}

impl DayFixtures {
    pub fn complete(&self) -> bool {
        self.total.is_some_and(|t| self.matches.len() as u64 >= t)
    }
}

pub fn day_key(sport: &str, date: &str, tz: &str) -> String {
    format!("day:{sport}:{date}:{tz}")
}

pub fn load_day(conn: &Connection, key: &str) -> DayFixtures {
    // Fixture lists stay valid all day; scores in them are not used.
    cache_get(conn, key, 86_400)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn save_day(conn: &Connection, key: &str, day: &DayFixtures) -> Result<(), AppError> {
    cache_put(conn, key, &serde_json::to_value(day).unwrap_or(Value::Null))
}

/// How long a match answer may be reused: a live match changes every minute.
pub fn match_ttl(m: &Value) -> i64 {
    let state = m
        .pointer("/state/description")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_lowercase();
    if state.contains("finished") || state.contains("cancel") || state.contains("postponed") {
        86_400
    } else if state.contains("not started") || state.contains("announced") {
        600
    } else {
        45
    }
}

pub fn cached(conn: &Connection, key: &str, max_age: i64) -> Result<Option<Value>, AppError> {
    cache_get(conn, key, max_age)
}

/// The cached body and its age in seconds, however old.
pub fn cached_with_age(conn: &Connection, key: &str) -> Option<(Value, i64)> {
    conn.query_row(
        "SELECT body, fetched_at FROM sports_cache WHERE key = ?1",
        [key],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|(b, at)| {
        serde_json::from_str(&b)
            .ok()
            .map(|v| (v, chrono::Utc::now().timestamp() - at))
    })
}

pub fn store(conn: &Connection, key: &str, body: &Value) -> Result<(), AppError> {
    cache_put(conn, key, body)
}

/// Whether paging may spend another request.
pub fn can_page(quota: &Quota) -> bool {
    let left = quota.remaining.load(Ordering::Relaxed);
    !(0..=RESERVE).contains(&left)
}

pub fn page_query(sport: &str, date: &str, tz: &str, offset: usize) -> String {
    format!(
        "/{sport}/matches?date={date}&timezone={}&limit={PAGE_SIZE}&offset={offset}",
        urlencode(tz)
    )
}

pub const fn max_pages() -> u32 {
    MAX_PAGES_PER_LOOKUP
}

pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn log_failure(what: &str, e: &AppError) {
    warn!("Highlightly {what} failed: {e}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn similar_names_meet_and_different_ones_do_not() {
        assert!(team_similarity("Man Utd", "Manchester United") >= 0.8);
        assert!(team_similarity("Arsenal FC", "Arsenal") >= 0.99);
        assert!(team_similarity("Atlético", "Atletico Madrid") >= 0.8);
        assert!(team_similarity("Bayern", "FC Bayern München") >= 0.6);
        assert!(team_similarity("Real Madrid", "Real Sociedad") < 0.6);
        assert!(team_similarity("Manchester City", "Manchester United") < 0.6);
        assert_eq!(team_similarity("", "Arsenal"), 0.0);
    }

    #[test]
    fn best_match_picks_the_fixture_either_way_round() {
        let fixtures = vec![
            json!({"id": 1, "homeTeam": {"name": "Chelsea"}, "awayTeam": {"name": "Arsenal"}}),
            json!({"id": 2, "homeTeam": {"name": "Manchester United"}, "awayTeam": {"name": "Liverpool"}}),
        ];
        assert_eq!(
            best_match(&fixtures, "Man Utd", "Liverpool").unwrap()["id"],
            2
        );
        // A guide that lists the away side first still finds the game.
        assert_eq!(
            best_match(&fixtures, "Arsenal", "Chelsea").unwrap()["id"],
            1
        );
        assert!(best_match(&fixtures, "Everton", "Fulham").is_none());
    }

    #[test]
    fn live_matches_are_cached_briefly_and_finished_ones_long() {
        assert_eq!(
            match_ttl(&json!({"state": {"description": "Second half"}})),
            45
        );
        assert_eq!(
            match_ttl(&json!({"state": {"description": "Finished"}})),
            86_400
        );
        assert_eq!(
            match_ttl(&json!({"state": {"description": "Not started"}})),
            600
        );
    }

    #[test]
    fn the_cache_round_trips_and_expires() {
        let conn = crate::db::test_helpers::setup_test_db();
        ensure_cache_table(&conn).unwrap();
        store(&conn, "k", &json!({"a": 1})).unwrap();
        assert_eq!(cached(&conn, "k", 60).unwrap(), Some(json!({"a": 1})));
        conn.execute("UPDATE sports_cache SET fetched_at = fetched_at - 120", [])
            .unwrap();
        assert_eq!(cached(&conn, "k", 60).unwrap(), None);
        let (stale, age) = cached_with_age(&conn, "k").unwrap();
        assert_eq!(stale, json!({"a": 1}));
        assert!(age >= 120);
    }

    #[test]
    fn only_known_sports_reach_a_url() {
        assert!(validate_sport("football").is_ok());
        assert!(validate_sport("../admin").is_err());
    }
}
