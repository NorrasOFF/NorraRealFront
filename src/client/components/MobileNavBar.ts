import { html, LitElement, TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import { translateText } from "../Utils";
import { NavNotificationsController } from "./NavNotificationsController";

@customElement("mobile-nav-bar")
export class MobileNavBar extends LitElement {
  private _notifications = new NavNotificationsController(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);
    const current = window.currentPageId;
    if (current) {
      this.updateComplete.then(() => this._updateActiveState(current));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("showPage", this._onShowPage);
  }

  private _onShowPage = (e: Event) => {
    this._updateActiveState((e as CustomEvent<string>).detail);
  };

  private _updateActiveState(pageId: string) {
    this.querySelectorAll(".nav-menu-item").forEach((el) => {
      const button = el.querySelector("button");
      const active = (el as HTMLElement).dataset.page === pageId;
      el.classList.toggle("active", active);
      button?.classList.toggle("active", active);
    });
  }

  private _renderDot(color: string): TemplateResult {
    return html`<span
      class="absolute right-3 top-1/2 h-2 w-2 -translate-y-1/2 ${color} rounded-full"
    ></span>`;
  }

  private _renderItem(
    pageId: string,
    labelKey: string,
    icon: TemplateResult,
    currentPage: string,
    notification?: TemplateResult,
    onSelect?: () => void,
  ): TemplateResult {
    const active = currentPage === pageId;
    return html`
      <div
        class="nav-menu-item rounded-lg ${active ? "active" : ""}"
        data-page=${pageId}
      >
        <button
          type="button"
          class="relative flex w-full items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left text-white/75 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white ${active
            ? "active border-malibu-blue/50 bg-malibu-blue/10 text-malibu-blue"
            : ""}"
          data-target=${pageId}
          aria-label=${translateText(labelKey)}
          title=${translateText(labelKey)}
          @click=${onSelect}
        >
          <span class="flex h-5 w-5 shrink-0 items-center justify-center">
            ${icon}
          </span>
          <span class="text-sm font-semibold">${translateText(labelKey)}</span>
          ${notification ?? ""}
        </button>
      </div>
    `;
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    return html`
      <nav class="flex w-full flex-col gap-2 p-3" aria-label="Main menu">
        <div
          class="mb-2 border-b border-white/10 px-2 pb-3 text-sm font-bold uppercase tracking-widest text-white/50"
        >
          ${translateText("main.menu")}
        </div>
        ${this._renderItem(
          "page-play",
          "main.play",
          html`<svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5"
            aria-hidden="true"
          >
            <path d="m9 6 10 6-10 6V6Z" />
          </svg>`,
          currentPage,
        )}
        ${this._renderItem(
          "page-news",
          "main.news",
          html`<svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M4 5h16v14H4z" />
            <path d="M8 9h8M8 13h8M8 17h5" />
          </svg>`,
          currentPage,
          this._notifications.showNewsDot()
            ? this._renderDot("bg-red-500")
            : undefined,
          this._notifications.onNewsClick,
        )}
        ${this._renderItem(
          "page-help",
          "main.help",
          html`<svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4" />
            <path d="M12 17.5h.01" />
          </svg>`,
          currentPage,
          this._notifications.showHelpDot()
            ? this._renderDot("bg-yellow-400")
            : undefined,
          this._notifications.onHelpClick,
        )}
        ${this._renderItem(
          "page-settings",
          "nav_account_menu.game_settings",
          html`<svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="m19.4 15 .1.1 1.1.9-1.1 1.9-1.3-.5a7.8 7.8 0 0 1-1.4.8l-.2 1.4h-2.2l-.2-1.4a7.8 7.8 0 0 1-1.4-.8l-1.3.5-1.1-1.9 1.1-.9a7.2 7.2 0 0 1 0-1.6l-1.1-.9 1.1-1.9 1.3.5a7.8 7.8 0 0 1 1.4-.8l.2-1.4h2.2l.2 1.4a7.8 7.8 0 0 1 1.4.8l1.3-.5 1.1 1.9-1.1.9a7.2 7.2 0 0 1 0 1.6Z"
            />
          </svg>`,
          currentPage,
        )}
      </nav>
    `;
  }
}
