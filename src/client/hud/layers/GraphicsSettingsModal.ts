import { GameEvent } from "../../../core/EventBus";

export class ShowGraphicsSettingsModalEvent implements GameEvent {
  constructor(
    public readonly isVisible: boolean = true,
    public readonly shouldPause: boolean = false,
    public readonly isPaused: boolean = false,
  ) {}
}
