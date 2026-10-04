import { html, LitElement, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { NavNotificationsController } from "./NavNotificationsController";

/**
 * News, help, and game settings as icon buttons, with notification dots.
 *
 * Shared by the desktop nav bar and the mobile top bar so both read as the same
 * cluster next to the profile control.
 */
@customElement("nav-utility-icons")
export class NavUtilityIcons extends LitElement {
  /** Mobile trims the hit area to fit the top bar beside the logo. */
  @property({ type: String }) size: "desktop" | "mobile" = "desktop";

  private _notifications = new NavNotificationsController(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);
  }

  disconnectedCallback() {
    window.removeEventListener("showPage", this._onShowPage);
    super.disconnectedCallback();
  }

  // The active page drives the highlight, and Navigation only updates
  // `.nav-menu-item` classes for elements that exist at click time.
  private _onShowPage = () => {
    this.requestUpdate();
  };

  private buttonClass(): string {
    const box = this.size === "mobile" ? "w-9 h-9" : "w-10 h-10";
    return (
      `nav-menu-item flex items-center justify-center ${box} rounded-full ` +
      "border border-white/10 bg-white/5 text-white/70 hover:border-white/20 " +
      "hover:bg-white/10 hover:text-malibu-blue cursor-pointer transition-colors " +
      "[&.active]:text-malibu-blue"
    );
  }

  private renderDot(color: string): TemplateResult {
    return html`
      <span
        class="absolute top-0 right-0 w-2 h-2 ${color} rounded-full animate-ping"
      ></span>
      <span class="absolute top-0 right-0 w-2 h-2 ${color} rounded-full"></span>
    `;
  }

  render(): TemplateResult {
    const currentPage = window.currentPageId;
    return html`
      <div class="flex items-center gap-1">
        ${this.size === "desktop"
          ? html`<button
              type="button"
              class="${this.buttonClass()} ${currentPage === "page-play"
                ? "active"
                : ""}"
              data-page="page-play"
              data-i18n-aria-label="main.play"
              data-i18n-title="main.play"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="w-5 h-5 pointer-events-none"
                aria-hidden="true"
              >
                <path d="m9 6 10 6-10 6V6Z" />
              </svg>
            </button>`
          : ""}
        <div class="relative">
          <button
            type="button"
            class="${this.buttonClass()} ${currentPage === "page-news"
              ? "active"
              : ""}"
            data-page="page-news"
            data-i18n-aria-label="main.news"
            data-i18n-title="main.news"
            @click=${this._notifications.onNewsClick}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="w-6 h-6 pointer-events-none"
              aria-hidden="true"
            >
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </button>
          ${this._notifications.showNewsDot()
            ? this.renderDot("bg-red-500")
            : ""}
        </div>
        <div class="relative">
          <button
            type="button"
            class="${this.buttonClass()} ${currentPage === "page-help"
              ? "active"
              : ""}"
            data-page="page-help"
            data-i18n-aria-label="main.help"
            data-i18n-title="main.help"
            @click=${this._notifications.onHelpClick}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="w-6 h-6 pointer-events-none"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4" />
              <line x1="12" y1="17.5" x2="12.01" y2="17.5" />
            </svg>
          </button>
          ${this._notifications.showHelpDot()
            ? this.renderDot("bg-yellow-400")
            : ""}
        </div>
        <button
          type="button"
          class="${this.buttonClass()} ${currentPage === "page-settings"
            ? "active"
            : ""}"
          data-page="page-settings"
          data-i18n-aria-label="nav_account_menu.game_settings"
          data-i18n-title="nav_account_menu.game_settings"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="w-5 h-5 pointer-events-none"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="m19.4 15 .1.1 1.1.9-1.1 1.9-1.3-.5a7.8 7.8 0 0 1-1.4.8l-.2 1.4h-2.2l-.2-1.4a7.8 7.8 0 0 1-1.4-.8l-1.3.5-1.1-1.9 1.1-.9a7.2 7.2 0 0 1 0-1.6l-1.1-.9 1.1-1.9 1.3.5a7.8 7.8 0 0 1 1.4-.8l.2-1.4h2.2l.2 1.4a7.8 7.8 0 0 1 1.4.8l1.3-.5 1.1 1.9-1.1.9a7.2 7.2 0 0 1 0 1.6Z"
            />
          </svg>
        </button>
      </div>
    `;
  }
}
