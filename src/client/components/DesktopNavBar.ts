import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "./NavAccountMenu";
import "./NavUtilityIcons";

@customElement("desktop-nav-bar")
export class DesktopNavBar extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <nav
        class="flex items-center justify-end gap-2 border-b border-white/10 bg-gray-950/80 px-4 py-2 backdrop-blur-sm"
        aria-label="Main menu"
      >
        <nav-utility-icons size="desktop"></nav-utility-icons>
        <nav-account-menu variant="desktop"></nav-account-menu>
      </nav>
    `;
  }
}
