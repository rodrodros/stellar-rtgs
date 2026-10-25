//! Behaviour, errors, boundaries and events, one file per family of actions.
//! Authorization trees are in `auth.rs`. Every test names the model IDs it checks
//! (rtgs-definition.md §4) and its ADRs, and its scenario ID in `tests/SCENARIOS.md`.
mod credit;
mod funding;
mod lsm;
mod payments;
mod queue_management;
mod storage;
