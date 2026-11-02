import { html, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { UserMeResponse } from "../core/ApiSchemas";
import {
  AccountTier,
  AccountTierInfo,
  searchAccountTiers,
  updateAccountTier,
} from "./Api";
import { ProfileMenuModal } from "./ProfileMenuModal";
import { showToast, translateText } from "./Utils";

/**
 * In-game admin panel for account tiers, opened from the nav profile menu
 * (`#modal=account-tiers`) and only rendered for accounts whose /users/@me
 * says `canManageAccountTiers`. Search by username/publicId, then set player,
 * host or admin. The server re-checks admin on every request.
 */
@customElement("account-tier-modal")
export class AccountTierModal extends ProfileMenuModal {
  protected routerName = "account-tiers";
  protected titleKey = "account_tier_modal.title";

  @state() private query = "";
  @state() private accounts: AccountTierInfo[] = [];
  @state() private loading = false;
  @state() private loadFailed = false;
  @state() private updatingPublicId: string | null = null;

  private readonly tiers: AccountTier[] = ["player", "host", "admin"];
  private readonly tierLabelKeys = {
    player: "account_tier_modal.tier_player",
    host: "account_tier_modal.tier_host",
    admin: "account_tier_modal.tier_admin",
  } as const;

  protected onOpenExtra(): void {
    this.query = "";
    this.accounts = [];
    this.loadFailed = false;
    void this.search("");
  }

  private async search(query: string): Promise<void> {
    this.loading = true;
    this.loadFailed = false;
    const result = await searchAccountTiers(query);
    this.loading = false;
    if (result === false) {
      this.loadFailed = true;
      this.accounts = [];
      return;
    }
    this.accounts = result;
  }

  private handleSearch = (event: Event): void => {
    event.preventDefault();
    void this.search(this.query);
  };

  private async changeTier(
    account: AccountTierInfo,
    tier: AccountTier,
  ): Promise<void> {
    if (this.updatingPublicId !== null || account.tier === tier) return;
    this.updatingPublicId = account.publicId;
    const result = await updateAccountTier(
      { publicId: account.publicId },
      tier,
    );
    this.updatingPublicId = null;
    if (!result.ok) {
      showToast(translateText("account_tier_modal.update_failed"), "red", 3000);
      return;
    }
    this.accounts = this.accounts.map((entry) =>
      entry.publicId === result.info.publicId ? result.info : entry,
    );
    showToast(
      translateText("account_tier_modal.update_success", {
        username: result.info.username,
        tier: translateText(this.tierLabelKeys[result.info.tier]),
      }),
      "green",
      3000,
    );
  }

  private renderTierButton(
    account: AccountTierInfo,
    tier: AccountTier,
  ): TemplateResult {
    const active = account.tier === tier;
    const busy = this.updatingPublicId === account.publicId;
    return html`
      <button
        type="button"
        ?disabled=${active || busy}
        @click=${() => this.changeTier(account, tier)}
        class="px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wide border transition-colors ${active
          ? "border-malibu-blue bg-malibu-blue/20 text-white"
          : "border-white/15 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"}"
      >
        ${translateText(this.tierLabelKeys[tier])}
      </button>
    `;
  }

  protected renderSignedIn(userMe: UserMeResponse): TemplateResult {
    if (userMe.player.canManageAccountTiers !== true) {
      return html`
        <div class="p-6">
          <div
            class="bg-white/5 rounded-xl border border-white/10 p-8 text-center text-sm text-white/60"
          >
            ${translateText("account_tier_modal.admin_only")}
          </div>
        </div>
      `;
    }

    return html`
      <div class="custom-scrollbar mr-1">
        <div class="p-6 space-y-4">
          <form class="flex gap-2" @submit=${this.handleSearch}>
            <input
              type="text"
              .value=${this.query}
              @input=${(event: Event) => {
                this.query = (event.target as HTMLInputElement).value;
              }}
              placeholder=${translateText(
                "account_tier_modal.search_placeholder",
              )}
              class="flex-1 min-w-0 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-malibu-blue"
            />
            <button
              type="submit"
              class="px-4 py-2 rounded-xl bg-malibu-blue text-white text-sm font-bold uppercase tracking-wide hover:bg-aquarius transition-colors"
            >
              ${translateText("account_tier_modal.search")}
            </button>
          </form>

          ${this.loading
            ? this.renderLoadingSpinner(
                translateText("account_tier_modal.loading"),
              )
            : this.loadFailed
              ? html`<p class="text-sm text-red-300">
                  ${translateText("account_tier_modal.load_failed")}
                </p>`
              : this.accounts.length === 0
                ? html`<p class="text-sm text-white/50">
                    ${translateText("account_tier_modal.no_results")}
                  </p>`
                : html`<div class="flex flex-col gap-2">
                    ${this.accounts.map(
                      (account) => html`
                        <div
                          class="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3"
                        >
                          <div class="flex flex-col min-w-0 flex-1">
                            <span class="text-sm font-bold text-white truncate"
                              >${account.username}</span
                            >
                            <span class="text-[10px] text-white/40 truncate"
                              >${account.publicId}</span
                            >
                          </div>
                          <div class="flex items-center gap-1.5">
                            ${this.tiers.map((tier) =>
                              this.renderTierButton(account, tier),
                            )}
                          </div>
                        </div>
                      `,
                    )}
                  </div>`}
        </div>
      </div>
    `;
  }
}
