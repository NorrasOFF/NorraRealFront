import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMeResponse } from "../../src/core/ApiSchemas";

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  getUserMe: vi.fn(),
  resetAccountPassword: vi.fn(),
  searchAccountTiers: vi.fn(),
  updateAccountTier: vi.fn(),
}));

import { AccountTierModal } from "../../src/client/AccountTierModal";
import {
  getUserMe,
  resetAccountPassword,
  searchAccountTiers,
  updateAccountTier,
} from "../../src/client/Api";

const bob = {
  publicId: "bob-public-id",
  username: "Bob",
  tier: "player" as const,
  canHostRanked: false,
  canManageTiers: false,
};

function userMe(admin: boolean): UserMeResponse {
  return {
    user: { email: "Remus" },
    player: {
      publicId: "remus-public-id",
      canCreatePublicLobbies: admin,
      canManageAccountTiers: admin,
    },
  } as unknown as UserMeResponse;
}

async function mount(): Promise<AccountTierModal> {
  const modal = new AccountTierModal();
  document.body.appendChild(modal);
  modal.open();
  await vi.waitFor(() => expect(getUserMe).toHaveBeenCalled());
  await modal.updateComplete;
  return modal;
}

beforeEach(() => {
  vi.mocked(getUserMe).mockResolvedValue(userMe(true));
  vi.mocked(searchAccountTiers).mockResolvedValue([bob]);
  vi.mocked(updateAccountTier).mockResolvedValue({
    ok: true,
    info: {
      ...bob,
      tier: "host",
      canHostRanked: true,
    },
  });
  vi.mocked(resetAccountPassword).mockResolvedValue({
    ok: true,
    info: bob,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("account tier modal", () => {
  it("lists accounts and updates a tier", async () => {
    const modal = await mount();

    await vi.waitFor(() => expect(modal.textContent).toContain("Bob"));
    const hostButton = Array.from(modal.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "account_tier_modal.tier_host",
    );
    expect(hostButton).toBeDefined();
    hostButton!.click();

    await vi.waitFor(() =>
      expect(updateAccountTier).toHaveBeenCalledWith(
        { publicId: bob.publicId },
        "host",
      ),
    );
    await vi.waitFor(() =>
      expect(modal.textContent).toContain("account_tier_modal.tier_host"),
    );
  });

  it("resets a password from the row form", async () => {
    const modal = await mount();
    await vi.waitFor(() => expect(modal.textContent).toContain("Bob"));

    const resetButton = Array.from(modal.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.trim() === "account_tier_modal.reset_password",
    );
    expect(resetButton).toBeDefined();
    resetButton!.click();
    await modal.updateComplete;

    const input = modal.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(input).not.toBeNull();
    input!.value = "brand new password";
    input!.dispatchEvent(new Event("input"));
    const form = input!.closest("form");
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event("submit", { cancelable: true }));

    await vi.waitFor(() =>
      expect(resetAccountPassword).toHaveBeenCalledWith(
        { publicId: bob.publicId },
        "brand new password",
      ),
    );
    await vi.waitFor(() =>
      expect(modal.querySelector('input[type="password"]')).toBeNull(),
    );
  });

  it("refuses non-admin accounts", async () => {
    vi.mocked(getUserMe).mockResolvedValue(userMe(false));
    const modal = await mount();

    await vi.waitFor(() =>
      expect(modal.textContent).toContain("account_tier_modal.admin_only"),
    );
  });
});
