import { describe, expect, it } from "vitest";
import { contiguousFrom } from "./PaymentHistory.tsx";

describe("contiguousFrom", () => {
  it("finds where the unbroken run down from the newest id starts", () => {
    expect(contiguousFrom(new Set())).toBeUndefined();
    expect(contiguousFrom(new Set([7n]))).toBe(7n);
    expect(contiguousFrom(new Set([1n, 5n, 6n]))).toBe(5n);
    expect(contiguousFrom(new Set([0n, 1n, 2n]))).toBe(0n);
  });
});
