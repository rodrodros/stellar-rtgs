//! Host-side tests. Unit and auth tests on the soroban-sdk test host (TESTING.md, "Unit and
//! auth tests"), and property and state-machine tests (TESTING.md, "Property and
//! state-machine tests"). `tests/SCENARIOS.md` lists the scenario each test runs.
mod support;

mod auth;
mod props;
mod reference;
mod state_machine;
mod unit;

// Model-based tests: Quint traces replayed against the contract (TESTING.md §3).
mod itf_replay;
