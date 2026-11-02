import { html } from "lit";
import { customElement, query } from "lit/decorators.js";
import { BaseModal } from "./components/BaseModal";
import "./components/leaderboard/LeaderboardPlayerList";
import type { LeaderboardPlayerList } from "./components/leaderboard/LeaderboardPlayerList";
import { modalHeader } from "./components/ui/ModalHeader";
import { translateText } from "./Utils";

@customElement("leaderboard-modal")
export class LeaderboardModal extends BaseModal {
  protected routerName = "leaderboard";

  @query("leaderboard-player-list")
  private playerList?: LeaderboardPlayerList;

  protected modalConfig() {
    return {
      tabs: [
        {
          key: "players",
          label: translateText("leaderboard_modal.ranked_tab"),
        },
      ],
    };
  }

  protected onOpen(): void {
    this.loadActiveTabData();
  }

  protected onTabEnter(): void {
    this.loadActiveTabData();
  }

  private loadActiveTabData() {
    void (async () => {
      if (!this.playerList) {
        await this.updateComplete;
      }
      await this.playerList?.ensureLoaded();
      this.playerList?.handleTabActivated();
    })();
  }

  protected renderHeaderSlot() {
    const refreshTime = html`<span
      class="text-sm font-normal text-white/40 ml-2 wrap-break-words italic"
      >(${translateText("leaderboard_modal.refresh_time")})</span
    >`;

    return modalHeader({
      titleContent: html`
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="text-white text-xl sm:text-2xl font-bold uppercase tracking-widest"
          >
            ${translateText("leaderboard_modal.title")}
          </span>
          ${refreshTime}
        </div>
      `,
      onBack: () => this.close(),
      ariaLabel: translateText("common.close"),
    });
  }

  protected renderBody() {
    return html`
      <div class="flex-1 min-h-0 h-full">
        <leaderboard-player-list class="h-full"></leaderboard-player-list>
      </div>
    `;
  }
}
