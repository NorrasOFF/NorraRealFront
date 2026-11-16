import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The modal's local-auth screens only render when the bootstrap config says
// this deployment uses self-hosted accounts.
vi.mock("../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => false as const),
  invalidateUserMe: vi.fn(),
  fetchPlayerById: vi.fn(async () => null),
  setMarketingConsent: vi.fn(async () => true),
  getApiBase: vi.fn(() => ""),
}));

const localAuthMocks = vi.hoisted(() => ({
  localResetPassword: vi.fn(),
  localRegister: vi.fn(),
  localLogin: vi.fn(),
}));
const { localResetPassword, localRegister } = localAuthMocks;

vi.mock("../../src/client/Auth", () => ({
  discordLogin: vi.fn(),
  googleLogin: vi.fn(),
  linkGoogle: vi.fn(async () => true),
  localChangePassword: vi.fn(),
  localGenerateRecoveryCode: vi.fn(),
  localLogin: (...args: unknown[]) => localAuthMocks.localLogin(...args),
  localRecoveryCodeEnabled: vi.fn(async () => true),
  localRegister: (...args: unknown[]) => localAuthMocks.localRegister(...args),
  localResetPassword: (...args: unknown[]) =>
    localAuthMocks.localResetPassword(...args),
  logOut: vi.fn(async () => true),
  reauthAfterCrazyGamesChange: vi.fn(async () => false),
  sendMagicLink: vi.fn(async () => true),
  getAuthHeader: vi.fn(async () => "Bearer test-token"),
}));

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  showToast: vi.fn(),
  getDiscordAvatarUrl: vi.fn(() => null),
  copyToClipboard: vi.fn(),
  renderNumber: vi.fn((n: number) => String(n)),
  getMapName: vi.fn((m: string) => m),
  renderDuration: vi.fn(() => ""),
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    getUserProfile: vi.fn(async () => null),
    showAuthPrompt: vi.fn(async () => null),
    isAvailable: false,
  },
}));

vi.mock("../../src/client/Cosmetics", () => ({
  fetchCosmetics: vi.fn(async () => null),
  translateCosmetic: vi.fn((v: unknown) => v),
}));

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
});

import { AccountModal } from "../../src/client/AccountModal";

function setBootstrap(localAuth: boolean): void {
  (window as unknown as { BOOTSTRAP_CONFIG: unknown }).BOOTSTRAP_CONFIG = {
    localAuth,
  };
}

async function settle(modal: AccountModal): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await modal.updateComplete;
}

function buttonByText(
  modal: AccountModal,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(modal.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  );
}

function inputByPlaceholder(
  modal: AccountModal,
  key: string,
): HTMLInputElement {
  const input = modal.querySelector<HTMLInputElement>(
    `input[placeholder="${key}"]`,
  );
  if (!input) throw new Error(`missing input ${key}`);
  return input;
}

async function typeInto(
  modal: AccountModal,
  key: string,
  value: string,
): Promise<void> {
  const input = inputByPlaceholder(modal, key);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await modal.updateComplete;
}

describe("AccountModal — local password reset", () => {
  let modal: AccountModal;

  beforeEach(async () => {
    setBootstrap(true);
    if (!customElements.get("account-modal")) {
      customElements.define("account-modal", AccountModal);
    }
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
  });

  afterEach(() => {
    document.body.removeChild(modal);
    vi.clearAllMocks();
    delete (window as { BOOTSTRAP_CONFIG?: unknown }).BOOTSTRAP_CONFIG;
  });

  it("opens the forgot-password form from the sign-in screen", async () => {
    modal.open();
    await settle(modal);

    expect(modal.textContent).toContain("account_modal.local_forgot_password");
    buttonByText(modal, "account_modal.local_forgot_password")!.click();
    await modal.updateComplete;

    expect(modal.textContent).toContain("account_modal.local_reset_title");
    expect(
      inputByPlaceholder(
        modal,
        "account_modal.local_recovery_code_placeholder",
      ),
    ).toBeTruthy();
  });

  it("does not call the API when the passwords differ", async () => {
    modal.open();
    await settle(modal);
    buttonByText(modal, "account_modal.local_forgot_password")!.click();
    await modal.updateComplete;

    await typeInto(modal, "account_modal.local_username_placeholder", "Alice");
    await typeInto(
      modal,
      "account_modal.local_recovery_code_placeholder",
      "ABCD-EFGH-JKLM-NPQR-STUV",
    );
    await typeInto(
      modal,
      "account_modal.local_new_password_placeholder",
      "battery staple",
    );
    await typeInto(
      modal,
      "account_modal.local_confirm_password_placeholder",
      "battery stapl",
    );

    buttonByText(modal, "account_modal.local_reset_submit")!.click();
    await settle(modal);

    expect(localResetPassword).not.toHaveBeenCalled();
    expect(modal.textContent).toContain("account_modal.local_passwords_differ");
  });

  it("shows the rotated recovery code after a successful reset", async () => {
    localResetPassword.mockResolvedValue({
      ok: true,
      recoveryCode: "WXYZ-2345-6789-ABCD-EFGH",
    });
    modal.open();
    await settle(modal);
    buttonByText(modal, "account_modal.local_forgot_password")!.click();
    await modal.updateComplete;

    await typeInto(modal, "account_modal.local_username_placeholder", "Alice");
    await typeInto(
      modal,
      "account_modal.local_recovery_code_placeholder",
      "ABCD-EFGH-JKLM-NPQR-STUV",
    );
    await typeInto(
      modal,
      "account_modal.local_new_password_placeholder",
      "battery staple",
    );
    await typeInto(
      modal,
      "account_modal.local_confirm_password_placeholder",
      "battery staple",
    );

    buttonByText(modal, "account_modal.local_reset_submit")!.click();
    await settle(modal);

    expect(localResetPassword).toHaveBeenCalledWith(
      "Alice",
      "ABCD-EFGH-JKLM-NPQR-STUV",
      "battery staple",
    );
    expect(modal.textContent).toContain("WXYZ-2345-6789-ABCD-EFGH");
    expect(modal.textContent).toContain(
      "account_modal.local_recovery_code_saved",
    );
  });

  it("shows a one-time recovery code after registration", async () => {
    localRegister.mockResolvedValue({
      ok: true,
      recoveryCode: "WXYZ-2345-6789-ABCD-EFGH",
    });
    modal.open();
    await settle(modal);

    await typeInto(modal, "account_modal.local_username_placeholder", "Alice");
    await typeInto(
      modal,
      "account_modal.local_password_placeholder",
      "correct horse",
    );

    buttonByText(modal, "account_modal.local_create_account")!.click();
    await settle(modal);

    expect(localRegister).toHaveBeenCalledWith("Alice", "correct horse");
    expect(modal.textContent).toContain("WXYZ-2345-6789-ABCD-EFGH");
    expect(modal.textContent).toContain(
      "account_modal.local_recovery_code_title",
    );
  });

  it("maps a rejected code to the recovery error message", async () => {
    localResetPassword.mockResolvedValue({
      ok: false,
      code: "invalid_recovery_code",
    });
    modal.open();
    await settle(modal);
    buttonByText(modal, "account_modal.local_forgot_password")!.click();
    await modal.updateComplete;

    await typeInto(modal, "account_modal.local_username_placeholder", "Alice");
    await typeInto(
      modal,
      "account_modal.local_recovery_code_placeholder",
      "AAAA-BBBB-CCCC-DDDD-EEEE",
    );
    await typeInto(
      modal,
      "account_modal.local_new_password_placeholder",
      "battery staple",
    );
    await typeInto(
      modal,
      "account_modal.local_confirm_password_placeholder",
      "battery staple",
    );

    buttonByText(modal, "account_modal.local_reset_submit")!.click();
    await settle(modal);

    expect(modal.textContent).toContain(
      "account_modal.local_invalid_recovery_code",
    );
    expect(modal.textContent).toContain("account_modal.local_reset_title");
  });

  it("keeps the upstream login screen when local auth is disabled", async () => {
    setBootstrap(false);
    modal.open();
    await settle(modal);

    expect(modal.textContent).not.toContain(
      "account_modal.local_forgot_password",
    );
    expect(modal.textContent).toContain("main.login_google");
  });
});
