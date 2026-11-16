import { html, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ClientEnv } from "src/client/ClientEnv";
import { PlayerStatsTree, UserMeResponse } from "../core/ApiSchemas";
import { assetUrl } from "../core/AssetUrls";
import { hasLinkedIdentity } from "./AccountIdentity";
import { fetchPlayerById, getUserMe, invalidateUserMe } from "./Api";
import {
  discordLogin,
  googleLogin,
  linkGoogle,
  localChangePassword,
  localGenerateRecoveryCode,
  localLogin,
  localRecoveryCodeEnabled,
  localRegister,
  localResetPassword,
  logOut,
  reauthAfterCrazyGamesChange,
  sendMagicLink,
} from "./Auth";
import "./components/baseComponents/stats/DiscordUserHeader";
import "./components/baseComponents/stats/PlayerGameHistoryView";
import type { PlayerGameHistoryCache } from "./components/baseComponents/stats/PlayerGameHistoryView";
import "./components/baseComponents/stats/PlayerStatsTable";
import "./components/baseComponents/stats/PlayerStatsTree";
import "./components/baseComponents/stats/SteamUserHeader";
import { BaseModal } from "./components/BaseModal";
import "./components/CopyButton";
import "./components/Difficulties";
import "./components/FriendsList";
import "./components/RewardsPanel";
import type { RewardsChangedDetail } from "./components/RewardsPanel";
import { googleLinkButton } from "./components/ui/GoogleLinkButton";
import { modalHeader } from "./components/ui/ModalHeader";
import { crazyGamesSDK, type CrazyGamesUser } from "./CrazyGamesSDK";
import { consumeGoogleLinkResult } from "./GoogleLinkResult";
import { showInGameAlert } from "./InGameModal";
import { consumeLoginResult, LoginResult } from "./LoginResult";
import { playerProfileUrl } from "./utilities/PlayerProfileUrl";
import { translateText } from "./Utils";

// window.openfrontDesktop is declared `unknown` by DesktopShell.ts (kept loose
// there on purpose). We know the one function we need, so narrow it locally
// rather than re-declaring the global (a second `declare global` with a
// different type triggers TS2717) — mirrors SteamSDK.ts's steamBridge().
//
// Guard on `showLinkGate` specifically, the function actually invoked below —
// not on a sibling property like `linkGate` (a separate namespace used by the
// gate page itself) — so a rename of one can't silently leave this button
// wired to nothing.
function desktopLinkGateBridge():
  | { showLinkGate: () => Promise<void> }
  | undefined {
  const desktop = window.openfrontDesktop as
    | { showLinkGate?: unknown }
    | undefined;
  return typeof desktop?.showLinkGate === "function"
    ? (desktop as { showLinkGate: () => Promise<void> })
    : undefined;
}

@customElement("account-modal")
export class AccountModal extends BaseModal {
  protected routerName = "account";

  @state() private email: string = "";
  @state() private isLoadingUser: boolean = false;
  // Set on CrazyGames when a CrazyGames user is signed in. Their identity comes
  // from the SDK, not our backend user object.
  @state() private crazyGamesUser: CrazyGamesUser | null = null;
  // One-shot outcome of a rejected sign-in, read from the `login=` router
  // arg on open. Reassigned on every open, so reopening clears it.
  @state() private loginError: LoginResult | undefined;
  @state() private localUsername = "";
  @state() private localPassword = "";
  @state() private localAuthError = "";
  @state() private localAuthBusy = false;
  // "signin" is the normal form; "reset" is the forgot-password form;
  // "recovery" shows a one-time recovery code after signup/reset.
  @state() private localAuthView: "signin" | "reset" | "recovery" = "signin";
  @state() private resetUsername = "";
  @state() private resetCode = "";
  @state() private resetPassword = "";
  @state() private resetPasswordConfirm = "";
  @state() private localRecoveryCode = "";
  // Signed-in account security panel.
  @state() private securityView: "none" | "password" | "recovery" = "none";
  @state() private securityError = "";
  @state() private securityNotice = "";
  @state() private securityBusy = false;
  @state() private currentPassword = "";
  @state() private newPassword = "";
  @state() private newPasswordConfirm = "";
  @state() private recoveryPassword = "";
  @state() private recoveryEnabled: boolean | null = null;
  // True when the one-time code was issued by signup/reset, so dismissing the
  // panel must reload the page to pick up the new session. A code regenerated
  // from the account tab only dismisses.
  private recoveryCodeNeedsReload = false;

  private userMeResponse: UserMeResponse | null = null;
  private statsTree: PlayerStatsTree | null = null;
  // Preserves the Games tab's accumulated list + cursor across tab switches.
  private gameHistoryCache: PlayerGameHistoryCache | null = null;
  private gamesScrollTop = 0;
  private restoreGamesScrollAfterOpen = false;

  constructor() {
    super();

    document.addEventListener("userMeResponse", (event: Event) => {
      // A CrazyGames sign-in fires userMeResponse (via Main's auth listener);
      // re-fetch the SDK profile so the modal leaves the sign-in screen.
      this.refreshCrazyGamesUser();
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        const previousPublicId = this.userMeResponse?.player?.publicId;
        this.userMeResponse = customEvent.detail as UserMeResponse;
        // Reset whenever the player identity changes (login, or switching to a
        // different account) so stats/history from the previous player don't
        // linger.
        if (this.userMeResponse?.player?.publicId !== previousPublicId) {
          this.resetPlayerData();
          this.requestUpdate();
        }
      } else {
        this.resetPlayerData();
        this.requestUpdate();
      }
    });
  }

  // Refresh the signed-in CrazyGames identity from the SDK. No-op off
  // CrazyGames; drives isLinkedAccount() so the modal shows the profile.
  private refreshCrazyGamesUser() {
    if (!crazyGamesSDK.isOnCrazyGames()) return;
    void crazyGamesSDK.getUserProfile().then((user) => {
      this.crazyGamesUser = user;
      this.requestUpdate();
    });
  }

  private hasAnyStats(): boolean {
    if (!this.statsTree) return false;
    // Check if statsTree has any data
    return (
      Object.keys(this.statsTree).length > 0 &&
      Object.values(this.statsTree).some(
        (gameTypeStats) =>
          gameTypeStats && Object.keys(gameTypeStats).length > 0,
      )
    );
  }

  protected renderHeaderSlot() {
    const isLoggedIn = !!this.userMeResponse?.user;
    const publicId = this.userMeResponse?.player?.publicId ?? "";
    return modalHeader({
      title: translateText("account_modal.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
      rightContent:
        isLoggedIn && !this.isLoadingUser && publicId
          ? html`
              <copy-button
                class="shrink-0"
                .copyText=${playerProfileUrl(publicId)}
                .displayText=${translateText("player_profile.share")}
                .showVisibilityToggle=${false}
              ></copy-button>
            `
          : undefined,
    });
  }

  private isLinkedAccount(): boolean {
    // The CrazyGames identity only counts once the backend token exchange
    // produced a session — otherwise a failed exchange would show a dead
    // "connected as" view with no way to retry.
    return (
      hasLinkedIdentity(this.userMeResponse?.user) ||
      (!!this.crazyGamesUser && this.userMeResponse !== null)
    );
  }

  protected modalConfig() {
    if (this.isLoadingUser || !this.isLinkedAccount()) {
      return {};
    }
    if (ClientEnv.localAuth()) {
      return {
        tabs: [
          { key: "account", label: translateText("account_modal.tab_account") },
        ],
      };
    }
    return {
      tabs: [
        { key: "account", label: translateText("account_modal.tab_account") },
        { key: "stats", label: translateText("account_modal.tab_stats") },
        { key: "games", label: translateText("account_modal.tab_games") },
        { key: "friends", label: translateText("account_modal.tab_friends") },
      ],
    };
  }

  protected renderBody(tab: string) {
    if (this.isLoadingUser) {
      return this.renderLoadingSpinner(
        translateText("account_modal.fetching_account"),
      );
    }
    if (!this.isLinkedAccount()) {
      return html`<div class="custom-scrollbar mr-1">
        ${ClientEnv.localAuth()
          ? this.renderLocalAuth()
          : crazyGamesSDK.isOnCrazyGames()
            ? this.renderCrazyGamesSignIn()
            : this.renderLoginOptions()}
      </div>`;
    }
    return html`
      <div class="custom-scrollbar mr-1">
        <div class="p-6">${this.renderTab(tab)}</div>
      </div>
    `;
  }

  private renderTab(tab: string): TemplateResult {
    switch (tab) {
      case "stats":
        return this.renderStatsTab();
      case "games":
        return this.renderGamesTab();
      case "friends":
        return this.renderFriendsTab();
      default:
        return this.renderAccountTab();
    }
  }

  // Email input + "get magic link" button used by the sign-in form.
  private renderEmailField(): TemplateResult {
    return html`
      <input
        type="email"
        .value=${this.email}
        @input=${this.handleEmailInput}
        placeholder=${translateText("account_modal.email_placeholder")}
        class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-malibu-blue/50 focus:border-malibu-blue/50 transition-all font-medium hover:bg-white/10"
      />
      <o-button
        variant="primary"
        width="block"
        size="md"
        translationKey="account_modal.get_magic_link"
        @click=${this.handleSubmit}
      ></o-button>
    `;
  }

  private renderFriendsTab(): TemplateResult {
    const myPublicId = this.userMeResponse?.player?.publicId ?? "";
    return html`<friends-list
      .myPublicId=${myPublicId}
      @view-profile=${(e: CustomEvent<{ publicId: string }>) =>
        this.openPlayerProfile(e.detail.publicId)}
    ></friends-list>`;
  }

  private openPlayerProfile(publicId: string): void {
    const profileModal = document.querySelector<
      HTMLElement & { openFromAccount(publicId: string): void }
    >("player-profile-modal");
    profileModal?.openFromAccount(publicId);
  }

  public returnToFriends(): void {
    this.open({ tab: "friends" });
  }

  private renderAccountTab(): TemplateResult {
    if (this.crazyGamesUser) {
      return this.renderCrazyGamesAccount(this.crazyGamesUser);
    }
    return html`
      <div class="flex flex-col gap-6">
        <div class="bg-white/5 rounded-xl border border-white/10 p-6">
          <div class="flex flex-col items-center gap-4">
            <div
              class="text-xs text-white/40 uppercase tracking-widest font-bold border-b border-white/5 pb-2 px-8"
            >
              ${translateText("account_modal.connected_as")}
            </div>
            <div class="flex items-center gap-8 justify-center flex-wrap">
              <discord-user-header
                .data=${this.userMeResponse?.user?.discord ?? null}
              ></discord-user-header>
              ${this.userMeResponse?.user?.steam
                ? html`<steam-user-header
                    .data=${this.userMeResponse.user.steam}
                  ></steam-user-header>`
                : null}
              ${this.renderLoggedInAs()}
            </div>
          </div>
        </div>
        ${this.renderLocalSecurity()} ${this.renderRewardsPanel()}
        ${this.renderDesktopLinkGateAction()}
      </div>
    `;
  }

  // Password + recovery-code management for the self-hosted username/password
  // accounts. Upstream accounts have their own provider-managed flows and get
  // nothing here.
  private renderLocalSecurity(): TemplateResult | typeof nothing {
    if (!ClientEnv.localAuth()) return nothing;
    return html`
      <div class="bg-white/5 rounded-xl border border-white/10 p-6">
        <div
          class="text-xs text-white/40 uppercase tracking-widest font-bold border-b border-white/5 pb-2 mb-4 text-center"
        >
          ${translateText("account_modal.local_security_title")}
        </div>
        ${this.securityNotice
          ? html`<div
              class="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
            >
              ${this.securityNotice}
            </div>`
          : null}
        ${this.securityError
          ? html`<div
              class="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
            >
              ${this.securityError}
            </div>`
          : null}
        ${this.localRecoveryCode
          ? this.renderRecoveryCodePanel()
          : this.securityView === "password"
            ? this.renderChangePasswordForm()
            : this.securityView === "recovery"
              ? this.renderRecoveryCodeForm()
              : this.renderSecurityActions()}
      </div>
    `;
  }

  private renderSecurityActions(): TemplateResult {
    const recoveryStatus =
      this.recoveryEnabled === null
        ? ""
        : this.recoveryEnabled
          ? translateText("account_modal.local_recovery_code_set")
          : translateText("account_modal.local_recovery_code_not_set");
    return html`
      <div class="flex flex-col gap-3">
        ${recoveryStatus
          ? html`<p class="text-sm text-white/50">${recoveryStatus}</p>`
          : null}
        <o-button
          variant="secondary"
          width="block"
          size="md"
          translationKey="account_modal.local_change_password"
          @click=${() => this.openSecurityView("password")}
        ></o-button>
        <o-button
          variant="ghost"
          width="block"
          size="sm"
          translationKey="account_modal.local_recovery_code_generate"
          @click=${() => this.openSecurityView("recovery")}
        ></o-button>
      </div>
    `;
  }

  private openSecurityView(view: "password" | "recovery"): void {
    this.securityView = view;
    this.securityError = "";
    this.securityNotice = "";
    this.currentPassword = "";
    this.newPassword = "";
    this.newPasswordConfirm = "";
    this.recoveryPassword = "";
  }

  private closeSecurityView(): void {
    this.openSecurityView("password");
    this.securityView = "none";
  }

  private renderPasswordInput(
    value: string,
    placeholderKey: string,
    autocomplete: string,
    onInput: (value: string) => void,
    onEnter?: () => void,
  ): TemplateResult {
    return html`
      <input
        type="password"
        autocomplete=${autocomplete}
        .value=${value}
        @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        placeholder=${translateText(placeholderKey)}
        class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-malibu-blue/50 focus:border-malibu-blue/50 transition-all font-medium hover:bg-white/10"
      />
    `;
  }

  private renderChangePasswordForm(): TemplateResult {
    return html`
      <div class="flex flex-col gap-3">
        <div class="text-sm font-medium text-white">
          ${translateText("account_modal.local_change_password_title")}
        </div>
        ${this.renderPasswordInput(
          this.currentPassword,
          "account_modal.local_current_password_placeholder",
          "current-password",
          (value) => (this.currentPassword = value),
        )}
        ${this.renderPasswordInput(
          this.newPassword,
          "account_modal.local_new_password_placeholder",
          "new-password",
          (value) => (this.newPassword = value),
        )}
        ${this.renderPasswordInput(
          this.newPasswordConfirm,
          "account_modal.local_confirm_password_placeholder",
          "new-password",
          (value) => (this.newPasswordConfirm = value),
          () => void this.handleChangePassword(),
        )}
        <div class="flex gap-2">
          <o-button
            variant="primary"
            width="fill"
            size="md"
            translationKey="account_modal.local_change_password_submit"
            ?disable=${this.securityBusy}
            @click=${() => void this.handleChangePassword()}
          ></o-button>
          <o-button
            variant="secondary"
            width="fill"
            size="md"
            translationKey="common.cancel"
            @click=${this.closeSecurityView}
          ></o-button>
        </div>
      </div>
    `;
  }

  private renderRecoveryCodeForm(): TemplateResult {
    return html`
      <div class="flex flex-col gap-3">
        <div class="text-sm font-medium text-white">
          ${translateText("account_modal.local_recovery_code_generate")}
        </div>
        <p class="text-sm text-white/50">
          ${translateText("account_modal.local_recovery_code_desc")}
        </p>
        ${this.renderPasswordInput(
          this.recoveryPassword,
          "account_modal.local_current_password_placeholder",
          "current-password",
          (value) => (this.recoveryPassword = value),
          () => void this.handleGenerateRecoveryCode(),
        )}
        <div class="flex gap-2">
          <o-button
            variant="primary"
            width="fill"
            size="md"
            translationKey="account_modal.local_recovery_code_generate"
            ?disable=${this.securityBusy}
            @click=${() => void this.handleGenerateRecoveryCode()}
          ></o-button>
          <o-button
            variant="secondary"
            width="fill"
            size="md"
            translationKey="common.cancel"
            @click=${this.closeSecurityView}
          ></o-button>
        </div>
      </div>
    `;
  }

  private renderRecoveryCodePanel(): TemplateResult {
    return html`
      <div class="flex flex-col items-center gap-3">
        <div class="text-sm font-medium text-white text-center">
          ${translateText("account_modal.local_recovery_code_title")}
        </div>
        <div
          class="font-mono text-lg font-bold tracking-widest text-white bg-black/30 border border-white/10 rounded-lg px-4 py-3 select-all"
        >
          ${this.localRecoveryCode}
        </div>
        <copy-button
          .copyText=${this.localRecoveryCode}
          .displayText=${translateText("common.copy")}
          .showVisibilityToggle=${false}
        ></copy-button>
        <p class="text-xs leading-snug text-amber-200/80 text-center">
          ${translateText("account_modal.local_recovery_code_desc")}
        </p>
        <o-button
          variant="primary"
          width="block"
          size="md"
          translationKey="account_modal.local_recovery_code_saved"
          @click=${this.finishRecoveryCode}
        ></o-button>
      </div>
    `;
  }

  private finishRecoveryCode(): void {
    // Registration and reset already established a session; a reload lets the
    // rest of the app pick up the new identity. When regenerating from an
    // already-signed-in account, just dismiss the one-time panel.
    if (this.recoveryCodeNeedsReload) {
      window.location.reload();
      return;
    }
    this.localRecoveryCode = "";
    this.securityView = "none";
    this.securityNotice = translateText(
      "account_modal.local_recovery_generated",
    );
  }

  private async handleChangePassword(): Promise<void> {
    if (this.securityBusy) return;
    this.securityError = "";
    this.securityNotice = "";
    if (this.newPassword !== this.newPasswordConfirm) {
      this.securityError = translateText(
        "account_modal.local_passwords_differ",
      );
      return;
    }
    this.securityBusy = true;
    const result = await localChangePassword(
      this.currentPassword,
      this.newPassword,
    );
    this.securityBusy = false;
    if (result.ok) {
      this.closeSecurityView();
      this.securityNotice = translateText(
        "account_modal.local_change_password_success",
      );
      return;
    }
    this.securityError = translateText(`account_modal.local_${result.code}`);
  }

  private async handleGenerateRecoveryCode(): Promise<void> {
    if (this.securityBusy) return;
    this.securityError = "";
    this.securityNotice = "";
    this.securityBusy = true;
    const result = await localGenerateRecoveryCode(this.recoveryPassword);
    this.securityBusy = false;
    if (result.ok) {
      this.localRecoveryCode = result.recoveryCode;
      this.recoveryCodeNeedsReload = false;
      this.recoveryEnabled = true;
      return;
    }
    this.securityError = translateText(`account_modal.local_${result.code}`);
  }

  private async loadRecoveryStatus(): Promise<void> {
    if (!ClientEnv.localAuth()) return;
    this.recoveryEnabled = await localRecoveryCodeEnabled();
  }

  // Re-entry to the desktop shell's account-linking gate shown at first
  // launch. Absent entirely on plain web (no window.openfrontDesktop there),
  // present whenever the desktop bridge exposes a callable showLinkGate —
  // see desktopLinkGateBridge() above for why the guard is scoped that way.
  // Needed because the desktop app's menu bar will eventually be hidden and
  // the game runs fullscreen borderless, so a dismissed or since-linked
  // player needs another way back to that gate.
  private renderDesktopLinkGateAction(): TemplateResult | typeof nothing {
    if (!desktopLinkGateBridge()) return nothing;
    return html`
      <o-button
        variant="secondary"
        width="block"
        size="md"
        translationKey="account_modal.link_existing_account"
        @click=${this.handleShowLinkGate}
      ></o-button>
    `;
  }

  private handleShowLinkGate(): void {
    // The bare `void` form swallowed a rejection into an unhandled promise.
    // This is an IPC round trip to the Electron main process, so it can
    // genuinely reject (no window, a main-process throw); catching keeps the
    // failure visible in the console instead of surfacing as a button that
    // silently does nothing.
    desktopLinkGateBridge()
      ?.showLinkGate()
      .catch((err) => {
        console.error("AccountModal: showLinkGate failed", err);
      });
  }

  // CrazyGames "connected as" view: avatar + username from the SDK. No
  // Discord/Google/email link or logout (CrazyGames owns the account and its
  // logout).
  private renderCrazyGamesAccount(user: CrazyGamesUser): TemplateResult {
    return html`
      <div class="flex flex-col gap-6">
        <div class="bg-white/5 rounded-xl border border-white/10 p-6">
          <div class="flex flex-col items-center gap-4">
            <div
              class="text-xs text-white/40 uppercase tracking-widest font-bold border-b border-white/5 pb-2 px-8"
            >
              ${translateText("account_modal.connected_as")}
            </div>
            <div class="flex flex-col items-center gap-3">
              <img
                src=${user.profilePictureUrl}
                alt=${user.username}
                class="w-16 h-16 rounded-full object-cover"
                referrerpolicy="no-referrer"
              />
              <div class="text-white text-lg font-medium">${user.username}</div>
            </div>
          </div>
        </div>
        ${this.renderRewardsPanel()}
      </div>
    `;
  }

  // Shown when a CrazyGames guest opens the modal: hand off to CrazyGames' own
  // sign-in prompt (no Discord/Google/email on CrazyGames).
  private renderCrazyGamesSignIn(): TemplateResult {
    return html`
      <div class="flex items-center justify-center p-6 min-h-full">
        <div
          class="w-full max-w-md bg-white/5 rounded-2xl border border-white/10 p-8 text-center"
        >
          <p class="text-white/50 text-sm font-medium mb-6">
            ${translateText("account_modal.sign_in_desc")}
          </p>
          <o-button
            variant="primary"
            width="block"
            size="md"
            translationKey="main.sign_in"
            @click=${this.handleCrazyGamesSignIn}
          ></o-button>
        </div>
      </div>
    `;
  }

  private renderStatsTab(): TemplateResult {
    if (!this.hasAnyStats()) {
      return this.renderEmptyState(
        "📊",
        translateText("account_modal.no_stats"),
      );
    }
    return html`
      <player-stats-tree-view
        .statsTree=${this.statsTree}
      ></player-stats-tree-view>
    `;
  }

  private renderGamesTab(): TemplateResult {
    const publicId = this.userMeResponse?.player?.publicId ?? "";
    if (!publicId) {
      return this.renderEmptyState(
        "🎮",
        translateText("account_modal.no_games"),
      );
    }
    return html`
      <player-game-history-view
        .publicId=${publicId}
        .cachedState=${this.gameHistoryCache?.publicId === publicId
          ? this.gameHistoryCache
          : null}
        @history-updated=${(e: CustomEvent<PlayerGameHistoryCache>) => {
          this.gameHistoryCache = e.detail;
        }}
        @view-stats=${(e: CustomEvent<{ gameId: string }>) =>
          this.openGameStats(e.detail.gameId)}
        @view-game=${(e: CustomEvent<{ gameId: string }>) =>
          void this.viewGame(e.detail.gameId)}
      ></player-game-history-view>
    `;
  }

  private renderEmptyState(icon: string, message: string): TemplateResult {
    return html`
      <div
        class="bg-white/5 rounded-xl border border-white/10 p-12 flex flex-col items-center justify-center text-center"
      >
        <div class="text-4xl mb-3">${icon}</div>
        <p class="text-white/60 text-sm">${message}</p>
      </div>
    `;
  }

  private renderRewardsPanel(): TemplateResult | "" {
    const rewards = this.userMeResponse?.player?.rewards ?? [];
    if (rewards.length === 0) return "";
    return html`<rewards-panel
      .rewards=${rewards}
      @rewards-changed=${this.handleRewardsChanged}
    ></rewards-panel>`;
  }

  // A claim moved unclaimed rewards into the balances; both were returned by
  // the claim endpoint, so update in place instead of re-fetching /users/@me.
  private handleRewardsChanged = (
    event: CustomEvent<RewardsChangedDetail>,
  ): void => {
    if (!this.userMeResponse) return;
    this.userMeResponse.player.rewards = event.detail.rewards;
    if (event.detail.currency) {
      this.userMeResponse.player.currency = event.detail.currency;
    }
    this.requestUpdate();
  };

  private renderLoggedInAs(): TemplateResult {
    const me = this.userMeResponse?.user;
    if (ClientEnv.localAuth()) {
      const accountName =
        me?.email ?? this.userMeResponse?.player?.username ?? "";
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          <div class="text-white text-lg font-medium">
            ${translateText("account_modal.linked_account", {
              account_name: accountName,
            })}
          </div>
          <button
            @click=${this.handleLogout}
            class="text-xs font-bold text-white/40 hover:text-red-400 transition-colors uppercase tracking-widest"
          >
            ${translateText("nav_account_menu.log_out")}
          </button>
        </div>
      `;
    }
    if (me?.discord) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          ${this.renderGoogleLink()}
        </div>
      `;
    } else if (me?.google) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          <div class="text-white text-lg font-medium">
            ${translateText("account_modal.linked_account", {
              account_name: me.google.email,
            })}
          </div>
        </div>
      `;
    } else if (me?.email) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          <div class="text-white text-lg font-medium">
            ${translateText("account_modal.linked_account", {
              account_name: me.email,
            })}
          </div>
          ${this.renderGoogleLink()}
        </div>
      `;
    } else if (me?.steam) {
      // Steam is the primary login and v1 does not support linking a second
      // identity or unlinking Steam itself, so no Discord/Google CTA here.
      return html`
        <div class="flex flex-col items-center gap-3 w-full"></div>
      `;
    }
    return html``;
  }

  // Show the Google link state: a confirmation line when a Google account is
  // already linked, otherwise the button to link one.
  private renderGoogleLink(): TemplateResult {
    const google = this.userMeResponse?.user?.google;
    if (google) {
      const label = google.email
        ? translateText("account_modal.linked_to_google_email", {
            email: google.email,
          })
        : translateText("account_modal.linked_to_google");
      return html`
        <div class="flex items-center gap-2 text-white/70 text-sm">
          <img
            src=${assetUrl("images/GoogleLogo.svg")}
            alt=${translateText("account_modal.google_alt")}
            class="w-4 h-4"
          />
          <span>${label}</span>
        </div>
      `;
    }
    return this.renderLinkGoogleButton();
  }

  // Shown when logged in without a Google identity yet. Lets the user attach
  // Google to their existing account (we never auto-merge by email).
  private renderLinkGoogleButton(): TemplateResult {
    if (this.userMeResponse?.user?.google) return html``;
    return googleLinkButton(this.handleLinkGoogle);
  }

  private async viewGame(gameId: string): Promise<void> {
    this.close();
    const encodedGameId = encodeURIComponent(gameId);
    const newUrl = `/${ClientEnv.workerPath(gameId)}/game/${encodedGameId}`;

    history.pushState({ join: gameId }, "", newUrl);
    window.dispatchEvent(
      new CustomEvent("join-changed", { detail: { gameId: encodedGameId } }),
    );
  }

  private openGameStats(gameId: string): void {
    this.gamesScrollTop = this.modalEl?.getScrollTop() ?? 0;
    const statsModal = document.querySelector<
      HTMLElement & { openFromAccount(gameId: string): void }
    >("game-stats-modal");
    statsModal?.openFromAccount(gameId);
  }

  public returnToGames(): void {
    this.restoreGamesScrollAfterOpen = true;
    this.open({ tab: "games" });
  }

  private async restoreGamesScroll(): Promise<void> {
    await this.updateComplete;
    await this.modalEl?.updateComplete;
    const historyView = this.querySelector<
      HTMLElement & { updateComplete?: Promise<boolean> }
    >("player-game-history-view");
    await historyView?.updateComplete;
    this.modalEl?.setScrollTop(this.gamesScrollTop);
  }

  private finishLoadingUser(): void {
    this.isLoadingUser = false;
    this.requestUpdate();
    if (this.restoreGamesScrollAfterOpen) {
      this.restoreGamesScrollAfterOpen = false;
      void this.restoreGamesScroll();
    }
  }

  private resetPlayerData(): void {
    this.statsTree = null;
    this.gameHistoryCache = null;
    this.gamesScrollTop = 0;
    this.restoreGamesScrollAfterOpen = false;
  }

  // Shown when a sign-in was rejected because the provider's verified email
  // already belongs to an account. We deliberately don't name which provider
  // that account uses — the visitor has only proven control of the email.
  private renderLoginError(): TemplateResult {
    if (this.loginError === undefined) return html``;
    return html`
      <div
        class="mb-6 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4"
      >
        <span class="text-red-400 text-lg leading-none" aria-hidden="true">
          &#9888;
        </span>
        <p class="flex-1 text-sm text-red-200">
          ${translateText("account_modal.login_email_exists")}
        </p>
        <button
          class="text-red-200/60 hover:text-red-200 text-lg leading-none"
          aria-label=${translateText("common.close")}
          @click=${() => (this.loginError = undefined)}
        >
          &times;
        </button>
      </div>
    `;
  }

  private renderLocalAuth() {
    if (this.localAuthView === "recovery")
      return this.renderLocalRecoveryCode();
    if (this.localAuthView === "reset") return this.renderLocalReset();
    return this.renderLocalSignIn();
  }

  private renderLocalAuthShell(content: TemplateResult): TemplateResult {
    return html`
      <div class="flex items-center justify-center p-6 min-h-full">
        <div
          class="w-full max-w-md bg-white/5 rounded-2xl border border-white/10 p-8"
        >
          ${content}
        </div>
      </div>
    `;
  }

  private renderLocalError(): TemplateResult | null {
    if (!this.localAuthError) return null;
    return html`<div
      class="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
    >
      ${this.localAuthError}
    </div>`;
  }

  private renderLocalSignIn(): TemplateResult {
    return this.renderLocalAuthShell(html`
      <div class="text-center mb-6">
        <p class="text-white/50 text-sm font-medium">
          ${translateText("account_modal.local_sign_in_desc")}
        </p>
      </div>

      ${this.renderLocalError()}

      <div class="space-y-4">
        <input
          type="text"
          autocomplete="username"
          .value=${this.localUsername}
          @input=${this.handleLocalUsername}
          placeholder=${translateText(
            "account_modal.local_username_placeholder",
          )}
          class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-malibu-blue/50 focus:border-malibu-blue/50 transition-all font-medium hover:bg-white/10"
        />
        <input
          type="password"
          autocomplete="current-password"
          .value=${this.localPassword}
          @input=${this.handleLocalPassword}
          @keydown=${this.handleLocalKeydown}
          placeholder=${translateText(
            "account_modal.local_password_placeholder",
          )}
          class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-malibu-blue/50 focus:border-malibu-blue/50 transition-all font-medium hover:bg-white/10"
        />
        <p class="text-xs leading-snug text-amber-200/80">
          ${translateText("account_modal.local_password_warning")}
        </p>
        <o-button
          variant="primary"
          width="block"
          size="md"
          translationKey="main.sign_in"
          ?disable=${this.localAuthBusy}
          @click=${() => this.handleLocalAuth("login")}
        ></o-button>
        <o-button
          variant="secondary"
          width="block"
          size="md"
          translationKey="account_modal.local_create_account"
          ?disable=${this.localAuthBusy}
          @click=${() => this.handleLocalAuth("register")}
        ></o-button>
        <button
          class="w-full text-center text-xs font-bold text-white/40 hover:text-white/70 transition-colors uppercase tracking-widest"
          @click=${() => this.openLocalAuthView("reset")}
        >
          ${translateText("account_modal.local_forgot_password")}
        </button>
      </div>
    `);
  }

  private renderLocalReset(): TemplateResult {
    return this.renderLocalAuthShell(html`
      <div class="text-center mb-6">
        <div class="text-white text-lg font-medium mb-2">
          ${translateText("account_modal.local_reset_title")}
        </div>
        <p class="text-white/50 text-sm font-medium">
          ${translateText("account_modal.local_reset_desc")}
        </p>
      </div>

      ${this.renderLocalError()}

      <div class="space-y-4">
        <input
          type="text"
          autocomplete="username"
          .value=${this.resetUsername}
          @input=${(e: Event) =>
            (this.resetUsername = (e.target as HTMLInputElement).value)}
          placeholder=${translateText(
            "account_modal.local_username_placeholder",
          )}
          class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-malibu-blue/50 focus:border-malibu-blue/50 transition-all font-medium hover:bg-white/10"
        />
        <input
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          .value=${this.resetCode}
          @input=${(e: Event) =>
            (this.resetCode = (e.target as HTMLInputElement).value)}
          placeholder=${translateText(
            "account_modal.local_recovery_code_placeholder",
          )}
          class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white font-mono tracking-wider placeholder-white/20 placeholder:font-sans placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-malibu-blue/50 focus:border-malibu-blue/50 transition-all hover:bg-white/10"
        />
        ${this.renderPasswordInput(
          this.resetPassword,
          "account_modal.local_new_password_placeholder",
          "new-password",
          (value) => (this.resetPassword = value),
        )}
        ${this.renderPasswordInput(
          this.resetPasswordConfirm,
          "account_modal.local_confirm_password_placeholder",
          "new-password",
          (value) => (this.resetPasswordConfirm = value),
          () => void this.handleLocalReset(),
        )}
        <o-button
          variant="primary"
          width="block"
          size="md"
          translationKey="account_modal.local_reset_submit"
          ?disable=${this.localAuthBusy}
          @click=${() => void this.handleLocalReset()}
        ></o-button>
        <button
          class="w-full text-center text-xs font-bold text-white/40 hover:text-white/70 transition-colors uppercase tracking-widest"
          @click=${() => this.openLocalAuthView("signin")}
        >
          ${translateText("account_modal.local_back_to_sign_in")}
        </button>
      </div>
    `);
  }

  private renderLocalRecoveryCode(): TemplateResult {
    return this.renderLocalAuthShell(this.renderRecoveryCodePanel());
  }

  private openLocalAuthView(view: "signin" | "reset"): void {
    this.localAuthView = view;
    this.localAuthError = "";
    this.resetCode = "";
    this.resetPassword = "";
    this.resetPasswordConfirm = "";
  }

  private handleLocalUsername(e: Event) {
    this.localUsername = (e.target as HTMLInputElement).value;
  }

  private handleLocalPassword(e: Event) {
    this.localPassword = (e.target as HTMLInputElement).value;
  }

  private handleLocalKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void this.handleLocalAuth("login");
  }

  private async handleLocalAuth(mode: "login" | "register") {
    if (this.localAuthBusy) return;
    this.localAuthBusy = true;
    this.localAuthError = "";
    if (mode === "login") {
      const result = await localLogin(this.localUsername, this.localPassword);
      if (result.ok) {
        window.location.reload();
        return;
      }
      this.localAuthError = translateText(`account_modal.local_${result.code}`);
      this.localAuthBusy = false;
      return;
    }
    const result = await localRegister(this.localUsername, this.localPassword);
    if (result.ok) {
      if (result.recoveryCode) {
        this.resetUsername = this.localUsername;
        this.localRecoveryCode = result.recoveryCode;
        this.recoveryCodeNeedsReload = true;
        this.localAuthView = "recovery";
        this.localAuthBusy = false;
        return;
      }
      window.location.reload();
      return;
    }
    this.localAuthError = translateText(`account_modal.local_${result.code}`);
    this.localAuthBusy = false;
  }

  private async handleLocalReset(): Promise<void> {
    if (this.localAuthBusy) return;
    this.localAuthError = "";
    if (this.resetPassword !== this.resetPasswordConfirm) {
      this.localAuthError = translateText(
        "account_modal.local_passwords_differ",
      );
      return;
    }
    this.localAuthBusy = true;
    const result = await localResetPassword(
      this.resetUsername,
      this.resetCode,
      this.resetPassword,
    );
    if (result.ok) {
      if (result.recoveryCode) {
        this.localRecoveryCode = result.recoveryCode;
        this.recoveryCodeNeedsReload = true;
        this.localAuthView = "recovery";
        this.localAuthBusy = false;
        return;
      }
      window.location.reload();
      return;
    }
    this.localAuthError = translateText(`account_modal.local_${result.code}`);
    this.localAuthBusy = false;
  }

  private renderLoginOptions() {
    return html`
      <div class="flex items-center justify-center p-6 min-h-full">
        <div
          class="w-full max-w-md bg-white/5 rounded-2xl border border-white/10 p-8"
        >
          <div class="text-center mb-8">
            <div
              class="w-16 h-16 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-white/10 shadow-inner"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="w-8 h-8 text-blue-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                <polyline points="10 17 15 12 10 7"></polyline>
                <line x1="15" y1="12" x2="3" y2="12"></line>
              </svg>
            </div>
            <p class="text-white/50 text-sm font-medium">
              ${translateText("account_modal.sign_in_desc")}
            </p>
          </div>

          ${this.renderLoginError()}

          <div class="space-y-6">
            <!-- Discord Login Button -->
            <button
              @click="${this.handleDiscordLogin}"
              class="w-full px-6 py-4 text-white bg-[#5865F2] hover:bg-[#4752C4] border border-transparent rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#5865F2] transition-colors duration-200 flex items-center justify-center gap-3 group relative overflow-hidden shadow-lg hover:shadow-[#5865F2]/20"
            >
              <img
                src=${assetUrl("images/DiscordLogo.svg")}
                alt="Discord"
                class="w-6 h-6 relative z-10"
              />
              <span class="font-bold relative z-10 tracking-wide"
                >${translateText("main.login_discord") ||
                translateText("account_modal.link_discord")}</span
              >
            </button>

            <!-- Google Login Button (Google brand guidelines: white surface,
                 dark text, the multicolor "G" mark) -->
            <button
              @click="${this.handleGoogleLogin}"
              class="w-full px-6 py-4 text-[#1f1f1f] bg-white hover:bg-[#f7f8f8] border border-[#dadce0] rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#4285F4] transition-colors duration-200 flex items-center justify-center gap-3 group relative overflow-hidden shadow-lg"
            >
              <img
                src=${assetUrl("images/GoogleLogo.svg")}
                alt=${translateText("account_modal.google_alt")}
                class="w-6 h-6 relative z-10"
              />
              <span class="font-bold relative z-10 tracking-wide"
                >${translateText("main.login_google")}</span
              >
            </button>

            <!-- Divider -->
            <div class="flex items-center gap-4 py-2">
              <div class="h-px bg-white/10 flex-1"></div>
              <span
                class="text-[10px] uppercase tracking-widest text-white/30 font-bold"
              >
                ${translateText("account_modal.or")}
              </span>
              <div class="h-px bg-white/10 flex-1"></div>
            </div>

            <!-- Email Recovery -->
            <div class="space-y-3">${this.renderEmailField()}</div>
          </div>

          <div class="mt-8 text-center border-t border-white/10 pt-6">
            <button
              @click="${this.handleLogout}"
              class="text-[10px] font-bold text-white/20 hover:text-red-400 transition-colors uppercase tracking-widest pb-0.5"
            >
              ${translateText("account_modal.clear_session")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private handleEmailInput(e: Event) {
    const target = e.target as HTMLInputElement;
    this.email = target.value;
  }

  private async handleSubmit() {
    if (!this.email) {
      await showInGameAlert(translateText("account_modal.enter_email_address"));
      return;
    }

    const success = await sendMagicLink(this.email);
    await showInGameAlert(
      success
        ? translateText("account_modal.recovery_email_sent", {
            email: this.email,
          })
        : translateText("account_modal.failed_to_send_recovery_email"),
    );
  }

  // CrazyGames sign-in: after their prompt completes, exchange the new token
  // for a session and refresh the modal so it shows the signed-in profile.
  private async handleCrazyGamesSignIn() {
    await crazyGamesSDK.showAuthPrompt();
    const profile = await crazyGamesSDK.getUserProfile();
    if (!profile) return; // prompt cancelled / still not signed in
    invalidateUserMe();
    await reauthAfterCrazyGamesChange();
    const userMe = await getUserMe();
    if (userMe) this.userMeResponse = userMe;
    this.crazyGamesUser = profile;
    this.requestUpdate();
  }

  private handleDiscordLogin() {
    discordLogin();
  }

  private handleGoogleLogin() {
    googleLogin();
  }

  private handleLinkGoogle = async (): Promise<void> => {
    // On success linkGoogle navigates to Google; the result comes back as a
    // `link=...` router arg handled by consumeGoogleLinkResult. A false return
    // means we couldn't start it.
    const started = await linkGoogle();
    if (!started) {
      await showInGameAlert(translateText("account_modal.link_google_failed"));
    }
  };

  protected onOpen(args?: Record<string, unknown>): void {
    this.isLoadingUser = true;
    this.localAuthView = "signin";
    this.localAuthError = "";
    this.localRecoveryCode = "";
    this.recoveryCodeNeedsReload = false;
    this.securityView = "none";
    this.securityError = "";
    this.securityNotice = "";
    this.recoveryEnabled = null;
    consumeGoogleLinkResult(args);
    this.loginError = consumeLoginResult(args);

    this.refreshCrazyGamesUser();

    void getUserMe()
      .then((userMe) => {
        if (userMe) {
          this.userMeResponse = userMe;
          if (this.userMeResponse?.player?.publicId) {
            this.loadPlayerProfile(this.userMeResponse.player.publicId);
          }
          void this.loadRecoveryStatus();
        }
        this.finishLoadingUser();
      })
      .catch((err) => {
        console.warn("Failed to fetch user info in AccountModal.open():", err);
        this.finishLoadingUser();
      });
    this.requestUpdate();
  }

  protected onClose(): void {
    this.dispatchEvent(
      new CustomEvent("close", { bubbles: true, composed: true }),
    );
  }

  private async handleLogout() {
    await logOut();
    this.close();
    // Refresh the page after logout to update the UI state
    window.location.reload();
  }

  private async loadPlayerProfile(publicId: string): Promise<void> {
    try {
      const data = await fetchPlayerById(publicId);
      if (!data) {
        this.requestUpdate();
        return;
      }

      this.statsTree = data.stats;

      this.requestUpdate();
    } catch (err) {
      console.warn("Failed to load player data:", err);
      this.requestUpdate();
    }
  }
}
