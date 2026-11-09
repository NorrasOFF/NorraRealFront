import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { userAuth } from "../Auth";
import { translateText } from "../Utils";
import { BaseModal } from "./BaseModal";
import { modalHeader } from "./ui/ModalHeader";

// Mode picker for ranked matchmaking. The rating itself is deliberately not
// displayed anywhere (not here, not in the leaderboard, not in lobbies).
@customElement("ranked-modal")
export class RankedModal extends BaseModal {
  protected routerName = "ranked";

  constructor() {
    super();
    this.id = "page-ranked";
  }

  createRenderRoot() {
    return this;
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("mode_selector.ranked_title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    return html`
      <div class="custom-scrollbar p-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          ${this.renderCard(
            translateText("mode_selector.ranked_1v1_title"),
            translateText("mode_selector.ranked_title"),
            () => this.handleRanked("1v1"),
          )}
          ${this.renderCard(
            translateText("mode_selector.ranked_2v2_title"),
            translateText("mode_selector.ranked_title"),
            () => this.handleRanked("2v2"),
          )}
          ${this.renderDisabledCard(
            translateText("mode_selector.coming_soon"),
            "",
          )}
          ${this.renderDisabledCard(
            translateText("mode_selector.coming_soon"),
            "",
          )}
        </div>
        <p class="mt-6 text-xs text-white/60 leading-relaxed text-center">
          ${translateText("mode_selector.ranked_pairing_note")}
        </p>
      </div>
    `;
  }

  private renderCard(title: string, subtitle: string, onClick: () => void) {
    return html`
      <button
        @click=${onClick}
        class="flex flex-col w-full h-28 sm:h-32 rounded-2xl bg-malibu-blue border-0 transition-all duration-200 hover:bg-aquarius hover:scale-[1.03] hover:shadow-[var(--shadow-action-card-hover)] active:bg-malibu-blue/80 active:scale-[0.98] p-6 items-center justify-center gap-3"
      >
        <div class="flex flex-col items-center gap-1 text-center">
          <h3
            class="text-lg sm:text-xl font-bold text-white uppercase tracking-widest leading-tight"
          >
            ${title}
          </h3>
          <p
            class="text-xs text-white/80 uppercase tracking-wider whitespace-pre-line leading-tight"
          >
            ${subtitle}
          </p>
        </div>
      </button>
    `;
  }

  private renderDisabledCard(title: string, subtitle: string) {
    return html`
      <div
        class="group relative isolate flex flex-col w-full h-28 sm:h-32 overflow-hidden rounded-2xl bg-slate-900/40 backdrop-blur-md border-0 shadow-none p-6 items-center justify-center gap-3 opacity-50 cursor-not-allowed"
      >
        <div class="flex flex-col items-center gap-1 text-center">
          <h3
            class="text-lg sm:text-xl font-bold text-white/60 uppercase tracking-widest leading-tight"
          >
            ${title}
          </h3>
          <p
            class="text-xs text-white/40 uppercase tracking-wider whitespace-pre-line leading-tight"
          >
            ${subtitle}
          </p>
        </div>
      </div>
    `;
  }

  private async handleRanked(mode: "1v1" | "2v2") {
    if ((await userAuth()) === false) {
      this.close();
      window.showPage?.("page-account");
      return;
    }

    document.dispatchEvent(
      new CustomEvent("open-matchmaking", { detail: { mode } }),
    );
  }
}
