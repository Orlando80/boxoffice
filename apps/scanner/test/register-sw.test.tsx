import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisterSw } from "../app/register-sw";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

function setSw(register: unknown) {
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register },
    configurable: true,
  });
}

describe("RegisterSw", () => {
  it("registers /sw.js exactly once", () => {
    const register = vi.fn().mockResolvedValue({});
    setSw(register);
    render(<RegisterSw />);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("does not throw without serviceWorker support", () => {
    expect("serviceWorker" in navigator).toBe(false);
    expect(() => render(<RegisterSw />)).not.toThrow();
  });

  it("handles rejection without unhandled rejection and logs", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setSw(vi.fn().mockRejectedValue(new Error("boom")));
    render(<RegisterSw />);
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(err).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    setSw(vi.fn().mockResolvedValue({}));
    const { container } = render(<RegisterSw />);
    expect(container.innerHTML).toBe("");
  });
});
