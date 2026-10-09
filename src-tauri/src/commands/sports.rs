//! Highlightly sports commands: find the match behind a programme, and its
//! live details, highlights and lineups. See `crate::sports` for the request
//! budget these work within.

use crate::commands::with_db;
use crate::error::AppError;
use crate::sports::{self, DayFixtures, QuotaInfo};
use crate::state::AppState;
use serde_json::Value;
use std::sync::atomic::Ordering;
use tauri::State;

async fn require_key(state: &AppState) -> Result<String, AppError> {
    with_db(&state.pool, sports::api_key).await?.ok_or_else(|| {
        AppError::Config(
            "Add a Highlightly API key under Display → Sports to see match data".into(),
        )
    })
}

fn validate_date(date: &str) -> Result<(), AppError> {
    let ok = date.len() == 10
        && date.chars().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        });
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput("Date must be YYYY-MM-DD".into()))
    }
}

fn validate_timezone(tz: &str) -> Result<(), AppError> {
    if !tz.is_empty()
        && tz.len() < 64
        && tz
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
    {
        Ok(())
    } else {
        Err(AppError::InvalidInput("Invalid time zone".into()))
    }
}

fn data_array(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        _ => v
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn sports_quota(state: State<'_, AppState>) -> Result<QuotaInfo, AppError> {
    let has_key = with_db(&state.pool, sports::api_key).await?.is_some();
    Ok(QuotaInfo {
        has_key,
        remaining: state.sports_quota.remaining.load(Ordering::Relaxed),
        limit: state.sports_quota.limit.load(Ordering::Relaxed),
    })
}

/// Stores (or, empty, removes) the Highlightly API key.
#[tauri::command]
pub async fn sports_set_key(state: State<'_, AppState>, key: String) -> Result<(), AppError> {
    let key = key.trim().to_string();
    if key.len() > 128 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::InvalidInput(
            "That does not look like an API key".into(),
        ));
    }
    with_db(&state.pool, move |conn| sports::store_api_key(conn, &key)).await
}

/// The fixture behind "home v away" on `date` (YYYY-MM-DD in `timezone`), or
/// null when the API has no such match. See the module docs for the order of
/// attempts and what each costs.
#[tauri::command]
pub async fn sports_find_match(
    state: State<'_, AppState>,
    sport: String,
    home: String,
    away: String,
    date: String,
    timezone: String,
) -> Result<Option<Value>, AppError> {
    let sport = sports::validate_sport(&sport)?;
    validate_date(&date)?;
    validate_timezone(&timezone)?;
    if home.trim().is_empty() || away.trim().is_empty() || home.len() > 80 || away.len() > 80 {
        return Err(AppError::InvalidInput("Two team names are needed".into()));
    }

    let norm = |s: &str| sports::team_tokens(s).join(" ");
    let found_key = format!("find:{sport}:{date}:{}:{}", norm(&home), norm(&away));
    let miss_key = format!("miss:{found_key}");
    let day_key = sports::day_key(sport, &date, &timezone);

    // Answered before (hit for six hours, miss for one), or in the fixture
    // pages already fetched today: no request at all.
    let (fk, mk, dk, h, a) = (
        found_key.clone(),
        miss_key.clone(),
        day_key.clone(),
        home.clone(),
        away.clone(),
    );
    let local = with_db(&state.pool, move |conn| {
        if let Some(v) = sports::cached(conn, &fk, 6 * 3600)? {
            return Ok(Some(Some(v)));
        }
        if sports::cached(conn, &mk, 3600)?.is_some() {
            return Ok(Some(None));
        }
        let day = sports::load_day(conn, &dk);
        if let Some(m) = sports::best_match(&day.matches, &h, &a) {
            sports::store(conn, &fk, m)?;
            return Ok(Some(Some(m.clone())));
        }
        Ok::<_, AppError>(None)
    })
    .await?;
    if let Some(answer) = local {
        return Ok(answer);
    }

    let key = require_key(&state).await?;
    let quota = state.sports_quota.clone();
    let pool = state.pool.clone();
    let remember = move |found: Option<Value>| {
        let pool = pool.clone();
        let (fk, mk) = (found_key.clone(), miss_key.clone());
        async move {
            with_db(&pool, move |conn| match &found {
                Some(m) => sports::store(conn, &fk, m),
                None => sports::store(conn, &mk, &Value::Bool(true)),
            })
            .await
        }
    };

    let mut day = with_db(&state.pool, {
        let dk = day_key.clone();
        move |conn| Ok(sports::load_day(conn, &dk))
    })
    .await?;

    // 1. The exact home team name: one request, right whenever the guide
    //    spells the team the way the API does. Skipped once paging started.
    if day.matches.is_empty() {
        let q = format!(
            "/{sport}/matches?date={date}&timezone={}&homeTeamName={}&limit=10",
            sports::urlencode(&timezone),
            sports::urlencode(home.trim())
        );
        match sports::fetch(&key, &q, &quota).await {
            Ok(v) => {
                if let Some(m) = sports::best_match(&data_array(&v), &home, &away) {
                    let m = m.clone();
                    remember(Some(m.clone())).await?;
                    return Ok(Some(m));
                }
            }
            Err(e) => sports::log_failure("exact team lookup", &e),
        }
    }

    // 2. The day's fixtures, a page at a time, stopping at the match.
    let mut pages = 0;
    while !day.complete() && pages < sports::max_pages() && sports::can_page(&quota) {
        let q = sports::page_query(sport, &date, &timezone, day.matches.len());
        let page = sports::fetch(&key, &q, &quota).await?;
        let fixtures = data_array(&page);
        day.total = page
            .pointer("/pagination/totalCount")
            .and_then(|t| t.as_u64())
            .or(Some(day.matches.len() as u64 + fixtures.len() as u64));
        let hit = sports::best_match(&fixtures, &home, &away).cloned();
        let empty = fixtures.is_empty();
        day.matches.extend(fixtures);
        let snapshot = DayFixtures {
            matches: day.matches.clone(),
            total: day.total,
        };
        let dk = day_key.clone();
        with_db(&state.pool, move |conn| {
            sports::save_day(conn, &dk, &snapshot)
        })
        .await?;
        if let Some(m) = hit {
            remember(Some(m.clone())).await?;
            return Ok(Some(m));
        }
        if empty {
            break;
        }
        pages += 1;
    }

    // Not found. Only a complete search is remembered as a miss; a search cut
    // short by the page cap or the reserve may succeed later.
    if day.complete() {
        remember(None).await?;
    }
    Ok(None)
}

/// Full details of one match: score, clock, events, statistics, predictions.
/// A live match is refetched at most every 45 seconds however often this is
/// asked; a finished one is kept for a day.
#[tauri::command]
pub async fn sports_match(
    state: State<'_, AppState>,
    sport: String,
    id: i64,
) -> Result<Value, AppError> {
    let sport = sports::validate_sport(&sport)?;
    let cache_key = format!("match:{sport}:{id}");
    let ck = cache_key.clone();
    let cached = with_db(&state.pool, move |conn| {
        Ok(sports::cached_with_age(conn, &ck))
    })
    .await?;
    if let Some((v, age)) = &cached {
        if *age <= sports::match_ttl(v) {
            return Ok(v.clone());
        }
    }

    let key = require_key(&state).await?;
    match sports::fetch(&key, &format!("/{sport}/matches/{id}"), &state.sports_quota).await {
        Ok(v) => {
            let m = data_array(&v).into_iter().next().unwrap_or(v);
            let (ck, body) = (cache_key, m.clone());
            with_db(&state.pool, move |conn| sports::store(conn, &ck, &body)).await?;
            Ok(m)
        }
        // Out of quota or offline: the last known state beats an error.
        Err(e) => match cached {
            Some((v, _)) => {
                sports::log_failure("match refresh", &e);
                Ok(v)
            }
            None => Err(e),
        },
    }
}

async fn cached_list(
    state: &AppState,
    cache_key: String,
    path: String,
    ttl: i64,
) -> Result<Value, AppError> {
    let ck = cache_key.clone();
    if let Some(v) = with_db(&state.pool, move |conn| sports::cached(conn, &ck, ttl)).await? {
        return Ok(v);
    }
    let key = require_key(state).await?;
    let v = sports::fetch(&key, &path, &state.sports_quota).await?;
    let body = v.clone();
    with_db(&state.pool, move |conn| {
        sports::store(conn, &cache_key, &body)
    })
    .await?;
    Ok(v)
}

/// Video highlights (clips, recaps) of one match.
#[tauri::command]
pub async fn sports_highlights(
    state: State<'_, AppState>,
    sport: String,
    match_id: i64,
) -> Result<Value, AppError> {
    let sport = sports::validate_sport(&sport)?;
    let v = cached_list(
        &state,
        format!("hl:{sport}:{match_id}"),
        format!("/{sport}/highlights?matchId={match_id}&limit=40"),
        1800,
    )
    .await?;
    Ok(Value::Array(data_array(&v)))
}

/// Starting line-ups and substitutes, for the sports that publish them.
#[tauri::command]
pub async fn sports_lineups(
    state: State<'_, AppState>,
    sport: String,
    match_id: i64,
) -> Result<Value, AppError> {
    let sport = sports::validate_sport(&sport)?;
    if !["football", "american-football", "baseball", "nba", "nhl"].contains(&sport) {
        return Err(AppError::InvalidInput(format!("No line-ups for {sport}")));
    }
    cached_list(
        &state,
        format!("lu:{sport}:{match_id}"),
        format!("/{sport}/lineups/{match_id}"),
        1800,
    )
    .await
}
