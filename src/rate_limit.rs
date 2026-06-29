use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct RateLimitStore {
    inner: Mutex<RateLimitInner>,
}

#[derive(Debug, Default)]
struct RateLimitInner {
    windows: HashMap<String, WindowCounter>,
    failures: HashMap<String, FailureCounter>,
}

#[derive(Debug)]
struct WindowCounter {
    window_started_at: Instant,
    count: u32,
}

#[derive(Debug, Clone)]
pub struct FailureCounter {
    count: u32,
    locked_until: Option<Instant>,
}

#[derive(Debug)]
pub enum RateLimitDecision {
    Allowed,
    Limited,
    Locked,
}

impl RateLimitStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RateLimitInner::default()),
        }
    }

    pub fn check_window(&self, key: String, limit: u32, window: Duration) -> RateLimitDecision {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("rate limit lock");
        cleanup_windows(&mut inner.windows, now, window);

        let counter = inner.windows.entry(key).or_insert(WindowCounter {
            window_started_at: now,
            count: 0,
        });

        if now.duration_since(counter.window_started_at) >= window {
            counter.window_started_at = now;
            counter.count = 0;
        }

        if counter.count >= limit {
            return RateLimitDecision::Limited;
        }

        counter.count += 1;
        RateLimitDecision::Allowed
    }

    pub fn check_failure_lock(&self, key: &str) -> RateLimitDecision {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("rate limit lock");
        cleanup_failure_locks(&mut inner.failures, now);

        if inner
            .failures
            .get(key)
            .and_then(|counter| counter.locked_until)
            .is_some_and(|locked_until| locked_until > now)
        {
            return RateLimitDecision::Locked;
        }

        RateLimitDecision::Allowed
    }

    pub fn record_business_failure(&self, key: String, limit: u32, lock_for: Duration) {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("rate limit lock");
        cleanup_failure_locks(&mut inner.failures, now);

        let counter = inner.failures.entry(key).or_insert(FailureCounter {
            count: 0,
            locked_until: None,
        });
        counter.count += 1;

        if counter.count >= limit {
            counter.locked_until = Some(now + lock_for);
        }
    }

    pub fn reset_business_failure(&self, key: &str) {
        let mut inner = self.inner.lock().expect("rate limit lock");
        inner.failures.remove(key);
    }
}

fn cleanup_windows(windows: &mut HashMap<String, WindowCounter>, now: Instant, window: Duration) {
    windows.retain(|_, counter| now.duration_since(counter.window_started_at) < window * 2);
}

fn cleanup_failure_locks(failures: &mut HashMap<String, FailureCounter>, now: Instant) {
    failures.retain(|_, counter| {
        counter
            .locked_until
            .map(|locked_until| locked_until > now)
            .unwrap_or(counter.count > 0)
    });
}
