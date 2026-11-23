import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { pluralize } from "./render-utils.js";

export interface WrappedPreviewOptions {
  bodyLines: string[];
  tail: string;
  rowLimit: number;
  expanded: boolean;
  formatOmitted: (text: string) => string;
}

export class WrappedPreviewText extends Text {
  private readonly bodyLines: string[];
  private readonly tail: string;
  private readonly rowLimit: number;
  private readonly expanded: boolean;
  private readonly formatOmitted: (text: string) => string;

  constructor(options: WrappedPreviewOptions) {
    super(`${options.bodyLines.join("\n")}${options.tail}`, 0, 0);
    this.bodyLines = options.bodyLines;
    this.tail = options.tail;
    this.rowLimit = Math.max(0, Math.floor(options.rowLimit));
    this.expanded = options.expanded;
    this.formatOmitted = options.formatOmitted;
  }

  override render(width: number): string[] {
    if (this.rowLimit > 0) {
      const contentWidth = Math.max(1, width);
      const rows = this.bodyLines.flatMap((line) =>
        wrapTextWithAnsi(line.replace(/\t/g, "   "), contentWidth),
      );
      if (rows.length > this.rowLimit) {
        const hidden = rows.length - this.rowLimit;
        const hint = `... (${hidden} more wrapped ${pluralize(hidden, "row")}${this.expanded ? "" : " • Ctrl+O to expand"})`;
        this.setText(
          `${rows.slice(0, this.rowLimit).join("\n")}\n${this.formatOmitted(hint)}${this.tail}`,
        );
      } else {
        this.setText(`${this.bodyLines.join("\n")}${this.tail}`);
      }
    }
    return super.render(width);
  }
}
