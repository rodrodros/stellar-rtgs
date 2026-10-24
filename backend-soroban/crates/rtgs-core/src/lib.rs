//! The RTGS's pure settlement rules: covers, queue order and the greatest feasible prefix.
//!
//! This crate has no soroban-sdk dependency and no `Env`, so its rules can be tested
//! natively, property-tested and proved with Kani, which cannot compile the soroban-sdk
//! test host (C-ST-059). The settlement contract calls it. It is empty until the first
//! rule moves here; see TESTING.md, "Property tests".
#![no_std]
