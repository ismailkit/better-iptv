//! EPG domain logic module
//!
//! This module contains business logic for EPG operations, separated from
//! database and command layers for better testability and maintainability.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use lazy_static::lazy_static;
use regex::Regex;

/// Validate EPG URL format
///
/// Ensures the URL is not empty and uses HTTP/HTTPS protocol.
///
/// # Arguments
/// * `url` - The EPG URL to validate
///
/// # Returns
/// * `Ok(())` if the URL is valid
/// * `Err(AppError::InvalidInput)` if the URL is invalid
///
/// # Examples
/// ```ignore
/// use better_ip_tv::epg_domain::validate_epg_url;
///
/// assert!(validate_epg_url("https://example.com/epg.xml").is_ok());
/// assert!(validate_epg_url("").is_err());
/// assert!(validate_epg_url("ftp://example.com/epg.xml").is_err());
/// ```ignore
pub fn validate_epg_url(url: &str) -> Result<(), AppError> {
    // Check if URL is empty or whitespace-only
    if url.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "EPG URL cannot be empty".to_string(),
        ));
    }

    // Ensure URL uses HTTP or HTTPS protocol
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::InvalidInput(
            "EPG URL must start with http:// or https://".to_string(),
        ));
    }

    Ok(())
}

/// Normalize EPG URL by trimming whitespace
///
/// This is a helper function to clean up user input before processing.
///
/// # Arguments
/// * `url` - The EPG URL to normalize
///
/// # Returns
/// * The normalized URL with leading/trailing whitespace removed
pub fn normalize_epg_url(url: &str) -> String {
    url.trim().to_string()
}

/// Check if URL points to a gzipped file based on extension
///
/// This is used to determine if we need to decompress the EPG data.
///
/// # Arguments
/// * `url` - The EPG URL to check
///
/// # Returns
/// * `true` if the URL ends with `.gz`, `false` otherwise
#[allow(dead_code)]
pub fn is_gzipped_url(url: &str) -> bool {
    url.ends_with(".gz")
}

/// Validate channel EPG ID format
///
/// Ensures the EPG ID is not empty and contains valid characters.
///
/// # Arguments
/// * `epg_id` - The channel EPG ID to validate
///
/// # Returns
/// * `Ok(())` if the EPG ID is valid
/// * `Err(AppError::InvalidInput)` if the EPG ID is invalid
pub fn validate_channel_epg_id(epg_id: &str) -> Result<(), AppError> {
    if epg_id.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Channel EPG ID cannot be empty".to_string(),
        ));
    }

    Ok(())
}

/// Longest window a single guide request may span.
pub const GUIDE_MAX_WINDOW_HOURS: i64 = 48;

/// Canonical form of an EPG channel id: trimmed and ASCII lower-cased.
///
/// XMLTV feeds and playlists disagree on case (`SVT1.se` vs `svt1.se`), and an
/// exact comparison made those channels show no guide data. ASCII-only so it
/// agrees with SQLite's `lower()`, which the one-time migration in
/// `db::schema` uses on rows stored before this existed.
pub fn normalize_epg_id(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

/// Longest range the "which channels have guide data" lookup may span: the
/// guide's five days fit with room for a day boundary in any time zone.
pub const GUIDE_IDS_MAX_WINDOW_HOURS: i64 = 168;

/// Most EPG ids one `get_guide` request may name. The frontend asks for every
/// row with guide data at once and splits larger sets into requests of this size.
pub const GUIDE_MAX_IDS: usize = 5000;

/// Validate and normalise a guide request's time window.
///
/// Parses `from` and `to` as RFC 3339, requires `to` to be strictly after
/// `from`, and rejects a window longer than `GUIDE_MAX_WINDOW_HOURS`. Returns
/// both bounds re-formatted as UTC `to_rfc3339()` strings, so a caller who
/// passed a non-UTC offset still gets values in the exact format
/// `store_epg_programs` writes, keeping the boundary string comparison in
/// `get_guide`'s SQL correct regardless of the caller's offset.
pub fn validate_guide_window(from: &str, to: &str) -> Result<(String, String), AppError> {
    validate_window(from, to, GUIDE_MAX_WINDOW_HOURS)
}

/// `validate_guide_window` for the id lookup, which spans the guide's days.
pub fn validate_guide_ids_window(from: &str, to: &str) -> Result<(String, String), AppError> {
    validate_window(from, to, GUIDE_IDS_MAX_WINDOW_HOURS)
}

fn validate_window(from: &str, to: &str, max_hours: i64) -> Result<(String, String), AppError> {
    let from_dt = DateTime::parse_from_rfc3339(from)
        .map_err(|e| AppError::InvalidInput(format!("Invalid 'from' timestamp: {}", e)))?
        .with_timezone(&Utc);
    let to_dt = DateTime::parse_from_rfc3339(to)
        .map_err(|e| AppError::InvalidInput(format!("Invalid 'to' timestamp: {}", e)))?
        .with_timezone(&Utc);

    if to_dt <= from_dt {
        return Err(AppError::InvalidInput(
            "'to' must be after 'from'".to_string(),
        ));
    }

    if to_dt - from_dt > chrono::Duration::hours(max_hours) {
        return Err(AppError::InvalidInput(format!(
            "Guide window cannot exceed {} hours",
            max_hours
        )));
    }

    Ok((from_dt.to_rfc3339(), to_dt.to_rfc3339()))
}

/// Reject a guide request naming more than `GUIDE_MAX_IDS` ids.
pub fn validate_guide_id_count(count: usize) -> Result<(), AppError> {
    if count > GUIDE_MAX_IDS {
        return Err(AppError::InvalidInput(format!(
            "At most {} EPG ids per guide request",
            GUIDE_MAX_IDS
        )));
    }
    Ok(())
}

/// How old `epg_last_fetched` may be before the background task refreshes.
pub const EPG_AUTO_REFRESH_INTERVAL_HOURS: i64 = 6;

/// Decide whether an automatic EPG refresh should run now.
///
/// `last_fetched` is the RFC 3339 string stored in the `epg_last_fetched`
/// setting. A missing or unreadable value counts as "never fetched".
pub fn epg_refresh_due(
    last_fetched: Option<&str>,
    now: DateTime<Utc>,
    interval_hours: i64,
) -> bool {
    match last_fetched.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(last) => now - last.with_timezone(&Utc) >= chrono::Duration::hours(interval_hours),
        None => true,
    }
}

/// Minimum spacing between automatic refresh attempts, so a broken EPG URL is
/// not re-downloaded at every poll.
pub const EPG_AUTO_REFRESH_RETRY_MINUTES: i64 = 60;

/// Decide whether the background task may attempt a refresh now, given the
/// time of its previous attempt (the `epg_last_attempt` setting, stamped
/// whether or not that attempt succeeded). A missing or unreadable value
/// counts as "never attempted".
pub fn epg_retry_allowed(
    last_attempt: Option<&str>,
    now: DateTime<Utc>,
    retry_minutes: i64,
) -> bool {
    match last_attempt.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(last) => now - last.with_timezone(&Utc) >= chrono::Duration::minutes(retry_minutes),
        None => true,
    }
}

lazy_static! {
    /// US TV Parental Guidelines: TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA.
    static ref TV_RATING_RE: Regex = Regex::new(r"(?i)\bTV-(Y7|Y|G|PG|14|MA)\b").unwrap();
    /// A named scheme with a number: "PEGI 16", "FSK: 12", "BBFC 15", "CSA -16".
    static ref SCHEME_RE: Regex =
        Regex::new(r"(?i)\b(?:PEGI|FSK|BBFC|CSA|USK|KIJKWIJZER|NICAM|IMDA|ACMA)\s*[:\-]?\s*-?(\d{1,2})\b")
            .unwrap();
    /// An age with an explicit sign: "18+", "+16", "(-12)", "[16+]".
    static ref SIGNED_AGE_RE: Regex =
        Regex::new(r"(?:^|[\s(\[])(?:\+\s?|-)(\d{1,2})\b|\b(\d{1,2})\s?\+").unwrap();
}

/// Ages a rating may stand for; anything else is a number that is not an age.
const AGES: [u8; 11] = [3, 6, 7, 10, 12, 13, 14, 15, 16, 17, 18];

fn as_age(n: u32) -> Option<u8> {
    let n = u8::try_from(n.min(18)).ok()?;
    AGES.contains(&n).then_some(n)
}

fn tv_rating_age(code: &str) -> Option<u8> {
    match code.to_ascii_uppercase().as_str() {
        "Y" | "G" => None,
        "Y7" => Some(7),
        "PG" => Some(10),
        "14" => Some(14),
        "MA" => Some(18),
        _ => None,
    }
}

/// Minimum age from the value of an XMLTV `<rating>` element.
///
/// Feeds write anything from a bare "16" to "FSK 16", "-16" (France), "12A",
/// "R18", "TV-MA" or the MPAA letters. Ratings for all audiences (U, G, TV-Y,
/// "0") give `None`: there is nothing to warn about.
pub fn age_from_rating(value: &str) -> Option<u8> {
    let v = value.trim();
    if let Some(c) = TV_RATING_RE.captures(v) {
        return tv_rating_age(&c[1]);
    }
    match v.to_ascii_uppercase().as_str() {
        "PG" => return Some(10),
        "PG-13" => return Some(13),
        "R" => return Some(17),
        "NC-17" | "X" | "XXX" | "R18" | "R18+" => return Some(18),
        _ => {}
    }
    // First number in the value: "16", "-16", "FSK 16", "12A", "18+".
    let digits: String = v
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok().and_then(as_age)
}

/// Minimum age written into a programme's title or synopsis, for feeds
/// without `<rating>` elements: "Film (18+)", "[+16]", "PEGI 12", "TV-MA".
///
/// Only explicit forms count (a sign, a named scheme or a TV code), so
/// "Episode 12" or "Top 40" never reads as an age. The highest age found wins.
pub fn age_from_text(text: &str) -> Option<u8> {
    let mut best: Option<u8> = None;
    let mut take = |age: Option<u8>| {
        if age > best {
            best = age;
        }
    };
    for c in TV_RATING_RE.captures_iter(text) {
        take(tv_rating_age(&c[1]));
    }
    for c in SCHEME_RE.captures_iter(text) {
        take(c[1].parse().ok().and_then(as_age));
    }
    for c in SIGNED_AGE_RE.captures_iter(text) {
        let n = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str());
        take(n.and_then(|n| n.parse().ok()).and_then(as_age));
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rating_values_map_to_minimum_ages() {
        assert_eq!(age_from_rating("18"), Some(18));
        assert_eq!(age_from_rating("-16"), Some(16));
        assert_eq!(age_from_rating("FSK 12"), Some(12));
        assert_eq!(age_from_rating("12A"), Some(12));
        assert_eq!(age_from_rating("R18"), Some(18));
        assert_eq!(age_from_rating("TV-MA"), Some(18));
        assert_eq!(age_from_rating("TV-14"), Some(14));
        assert_eq!(age_from_rating("PG-13"), Some(13));
        assert_eq!(age_from_rating("NC-17"), Some(18));
        assert_eq!(age_from_rating("21"), Some(18));
        // All audiences, or not an age at all.
        assert_eq!(age_from_rating("U"), None);
        assert_eq!(age_from_rating("TV-G"), None);
        assert_eq!(age_from_rating("0"), None);
        assert_eq!(age_from_rating("Tous publics"), None);
    }

    #[test]
    fn explicit_ages_in_titles_are_found() {
        assert_eq!(age_from_text("Late Movie (18+)"), Some(18));
        assert_eq!(age_from_text("Thriller [+16]"), Some(16));
        assert_eq!(age_from_text("Film -12"), Some(12));
        assert_eq!(age_from_text("Drama. PEGI 16. Violence."), Some(16));
        assert_eq!(age_from_text("Rated TV-MA for language"), Some(18));
        assert_eq!(age_from_text("Kids show 7+ and a 16+ trailer"), Some(16));
    }

    #[test]
    fn plain_numbers_are_not_ages() {
        assert_eq!(age_from_text("Episode 12"), None);
        assert_eq!(age_from_text("Top 40"), None);
        assert_eq!(age_from_text("Movie (2016)"), None);
        assert_eq!(age_from_text("Season 3 - 16 teams left"), None);
        assert_eq!(age_from_text("F1: Race 18"), None);
    }

    #[test]
    fn epg_ids_are_normalised_to_trimmed_ascii_lowercase() {
        assert_eq!(normalize_epg_id("SVT1.se"), "svt1.se");
        assert_eq!(normalize_epg_id("  TV4.SE "), "tv4.se");
        assert_eq!(normalize_epg_id("svt1.se"), "svt1.se");
        // Non-ASCII letters are left alone, matching SQLite's lower().
        assert_eq!(normalize_epg_id("Ämne.se"), "Ämne.se");
    }

    #[test]
    fn test_validate_epg_url_valid_https() {
        assert!(validate_epg_url("https://example.com/epg.xml").is_ok());
    }

    #[test]
    fn test_validate_epg_url_valid_http() {
        assert!(validate_epg_url("http://example.com/epg.xml.gz").is_ok());
    }

    #[test]
    fn test_validate_epg_url_empty() {
        assert!(validate_epg_url("").is_err());
    }

    #[test]
    fn test_validate_epg_url_whitespace() {
        assert!(validate_epg_url("   ").is_err());
    }

    #[test]
    fn test_validate_epg_url_invalid_protocol() {
        assert!(validate_epg_url("ftp://example.com/epg.xml").is_err());
    }

    #[test]
    fn test_validate_epg_url_no_protocol() {
        assert!(validate_epg_url("example.com/epg.xml").is_err());
    }

    #[test]
    fn test_normalize_epg_url() {
        assert_eq!(
            normalize_epg_url("  https://example.com/epg.xml  "),
            "https://example.com/epg.xml"
        );
    }

    #[test]
    fn test_normalize_epg_url_no_whitespace() {
        assert_eq!(
            normalize_epg_url("https://example.com/epg.xml"),
            "https://example.com/epg.xml"
        );
    }

    #[test]
    fn test_is_gzipped_url_true() {
        assert!(is_gzipped_url("https://example.com/epg.xml.gz"));
    }

    #[test]
    fn test_is_gzipped_url_false() {
        assert!(!is_gzipped_url("https://example.com/epg.xml"));
    }

    #[test]
    fn test_validate_channel_epg_id_valid() {
        assert!(validate_channel_epg_id("channel123").is_ok());
    }

    #[test]
    fn test_validate_channel_epg_id_empty() {
        assert!(validate_channel_epg_id("").is_err());
    }

    #[test]
    fn test_validate_channel_epg_id_whitespace() {
        assert!(validate_channel_epg_id("   ").is_err());
    }

    mod refresh_due {
        use super::super::{epg_refresh_due, EPG_AUTO_REFRESH_INTERVAL_HOURS};
        use chrono::{Duration, Utc};

        #[test]
        fn never_fetched_is_due() {
            assert!(epg_refresh_due(
                None,
                Utc::now(),
                EPG_AUTO_REFRESH_INTERVAL_HOURS
            ));
        }

        #[test]
        fn unparsable_timestamp_is_due() {
            assert!(epg_refresh_due(
                Some("yesterday"),
                Utc::now(),
                EPG_AUTO_REFRESH_INTERVAL_HOURS
            ));
        }

        #[test]
        fn recent_fetch_is_not_due() {
            let now = Utc::now();
            let last = (now - Duration::hours(1)).to_rfc3339();
            assert!(!epg_refresh_due(Some(&last), now, 6));
        }

        #[test]
        fn fetch_older_than_interval_is_due() {
            let now = Utc::now();
            let last = (now - Duration::hours(6) - Duration::minutes(1)).to_rfc3339();
            assert!(epg_refresh_due(Some(&last), now, 6));
        }

        #[test]
        fn accepts_the_timestamp_format_written_by_force_refresh() {
            // chrono's to_rfc3339 with nanoseconds, as stored in epg_last_fetched.
            let now = Utc::now();
            assert!(!epg_refresh_due(
                Some("2026-03-15T15:03:20.435045575+00:00"),
                now,
                24 * 365 * 10
            ));
            assert!(epg_refresh_due(
                Some("2026-03-15T15:03:20.435045575+00:00"),
                now,
                6
            ));
        }
    }

    mod retry_allowed {
        use super::super::{epg_retry_allowed, EPG_AUTO_REFRESH_RETRY_MINUTES};
        use chrono::{Duration, Utc};

        #[test]
        fn never_attempted_is_allowed() {
            assert!(epg_retry_allowed(
                None,
                Utc::now(),
                EPG_AUTO_REFRESH_RETRY_MINUTES
            ));
        }

        #[test]
        fn unparsable_timestamp_is_allowed() {
            assert!(epg_retry_allowed(
                Some("yesterday"),
                Utc::now(),
                EPG_AUTO_REFRESH_RETRY_MINUTES
            ));
        }

        #[test]
        fn recent_attempt_blocks_retry() {
            let now = Utc::now();
            let last = (now - Duration::minutes(10)).to_rfc3339();
            assert!(!epg_retry_allowed(Some(&last), now, 60));
        }

        #[test]
        fn attempt_older_than_retry_window_is_allowed() {
            let now = Utc::now();
            let last = (now - Duration::minutes(61)).to_rfc3339();
            assert!(epg_retry_allowed(Some(&last), now, 60));
        }

        #[test]
        fn retry_window_is_one_hour() {
            assert_eq!(EPG_AUTO_REFRESH_RETRY_MINUTES, 60);
        }
    }

    mod guide_window {
        use super::super::{
            validate_guide_id_count, validate_guide_ids_window, validate_guide_window,
        };
        use crate::error::AppError;
        use chrono::{Duration, Utc};

        #[test]
        fn valid_window_is_accepted_and_normalised_to_utc() {
            let from = Utc::now();
            let to = from + Duration::hours(1);
            // Same instants, but `from` given with a +02:00 offset.
            let from_offset = from
                .with_timezone(&chrono::FixedOffset::east_opt(2 * 3600).unwrap())
                .to_rfc3339();

            let (norm_from, norm_to) =
                validate_guide_window(&from_offset, &to.to_rfc3339()).unwrap();

            assert_eq!(norm_from, from.to_rfc3339());
            assert_eq!(norm_to, to.to_rfc3339());
        }

        #[test]
        fn unparsable_from_is_rejected() {
            let to = Utc::now() + Duration::hours(1);
            let err = validate_guide_window("not-a-date", &to.to_rfc3339()).unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)));
        }

        #[test]
        fn unparsable_to_is_rejected() {
            let from = Utc::now();
            let err = validate_guide_window(&from.to_rfc3339(), "not-a-date").unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)));
        }

        #[test]
        fn equal_bounds_are_rejected() {
            let now = Utc::now().to_rfc3339();
            assert!(validate_guide_window(&now, &now).is_err());
        }

        #[test]
        fn inverted_window_is_rejected() {
            let now = Utc::now();
            let earlier = (now - Duration::hours(1)).to_rfc3339();
            assert!(validate_guide_window(&now.to_rfc3339(), &earlier).is_err());
        }

        #[test]
        fn window_longer_than_48_hours_is_rejected() {
            let from = Utc::now();
            let to = from + Duration::hours(48) + Duration::minutes(1);
            assert!(validate_guide_window(&from.to_rfc3339(), &to.to_rfc3339()).is_err());
        }

        #[test]
        fn window_of_exactly_48_hours_is_accepted() {
            let from = Utc::now();
            let to = from + Duration::hours(48);
            assert!(validate_guide_window(&from.to_rfc3339(), &to.to_rfc3339()).is_ok());
        }

        #[test]
        fn ids_window_accepts_seven_days_and_rejects_more() {
            let from = Utc::now();
            let week = from + Duration::hours(168);
            assert!(validate_guide_ids_window(&from.to_rfc3339(), &week.to_rfc3339()).is_ok());
            let longer = week + Duration::minutes(1);
            assert!(validate_guide_ids_window(&from.to_rfc3339(), &longer.to_rfc3339()).is_err());
        }

        #[test]
        fn ids_window_rejects_unparsable_and_inverted_bounds() {
            let now = Utc::now();
            assert!(validate_guide_ids_window("nope", &now.to_rfc3339()).is_err());
            let earlier = (now - Duration::hours(1)).to_rfc3339();
            assert!(validate_guide_ids_window(&now.to_rfc3339(), &earlier).is_err());
        }

        #[test]
        fn ids_window_returns_utc_bounds() {
            let (from, to) =
                validate_guide_ids_window("2026-10-08T00:00:00+02:00", "2026-10-13T00:00:00+02:00")
                    .unwrap();
            assert_eq!(from, "2026-10-07T22:00:00+00:00");
            assert_eq!(to, "2026-10-12T22:00:00+00:00");
        }

        #[test]
        fn guide_id_count_allows_5000_and_rejects_5001() {
            assert!(validate_guide_id_count(5000).is_ok());
            assert!(matches!(
                validate_guide_id_count(5001),
                Err(AppError::InvalidInput(_))
            ));
        }
    }
}
