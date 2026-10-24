//! Unit and auth tests on the soroban-sdk test host. See TESTING.md, "Unit and auth tests",
//! and `tests/SCENARIOS.md` for the scenario each test runs.
mod support;

mod auth;
mod unit;

// Model-based tests: Quint traces replayed against the contract (TESTING.md §3).
mod itf_replay;
