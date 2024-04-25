import { TagElementProps } from "zotero-plugin-toolkit/dist/tools/ui";
import { getString } from "../utils/locale";
import { config } from "../../package.json";
import { getPref, MasterItem } from "../utils/prefs";
import { truncateString } from "../utils/utils";
import { fetchDuplicates } from "./duplicates";
import { merge } from "./merger";
import { isInDuplicatesPane, refreshItemTree } from "../utils/zotero";
import { updateButtonDisabled } from "../utils/view";
import { DuplicateItems } from "./duplicateItems";

export class BulkDuplicates {
  static getInstance(): BulkDuplicates {
    if (!BulkDuplicates.instance) {
      BulkDuplicates.instance = new BulkDuplicates();
    }
    return BulkDuplicates.instance;
  }

  private constructor() {}

  public static readonly bulkMergeButtonID = "zoplicate-bulk-merge-button";
  public static readonly innerButtonID = this.bulkMergeButtonID + "-inner";
  public static readonly externalButtonID = this.bulkMergeButtonID + "-external";
  private win: Window | undefined;
  private static instance: BulkDuplicates;
  private _isRunning = false;
  public get isRunning(): boolean {
    return this._isRunning;
  }

  private set isRunning(value: boolean) {
    this._isRunning = value;
    const imageName = value ? "pause" : "merge";
    const label = value ? "bulk-merge-suspend" : "bulk-merge-title";
    this.getBulkMergeButtons(this.win!).forEach((button) => {
      button?.setAttribute("image", `chrome://${config.addonRef}/content/icons/${imageName}.svg`);
      button?.setAttribute("label", getString(label));
    });
    if (!value) {
      addon.data.needResetDuplicateSearch[ZoteroPane.getSelectedLibraryID()] = true;
      // Force refresh the duplicate item tree
      refreshItemTree();
    }
  }

  private getBulkMergeButtons(win: Window) {
    return [win.document.getElementById(BulkDuplicates.innerButtonID), win.document.getElementById(BulkDuplicates.externalButtonID)];
  }

  public createBulkMergeButton(win: Window, id: string): TagElementProps {
    return {
      tag: "button",
      id: id,
      attributes: {
        label: getString("bulk-merge-title"),
        image: `chrome://${config.addonRef}/content/icons/merge.svg`,
      },
      classList: ["duplicate-box-button"],
      namespace: "xul",
      listeners: [
        {
          type: "click",
          listener: async (e) => {
            if ((e.target as HTMLInputElement).disabled) return;

            if (this._isRunning) {
              this.isRunning = false;
              return;
            }

            const pref = getPref("bulk.master.item");
            const masterItem = getString(`bulk-merge-master-item-${pref}`);
            const text = `${getString("bulk-merge-message")}\n\n${getString("bulk-merge-sub-message", {
              args: { masterItem },
            })}\n${getString("bulk-merge-sub-message-2")}`;
            // https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/prompt.js#L60
            // https://firefox-source-docs.mozilla.org/toolkit/components/prompts/prompts/nsIPromptService-reference.html#Prompter.confirmEx
            const result = Zotero.Prompt.confirm({
              window: win,
              title: getString("bulk-merge-title"),
              text: text,
              button0: Zotero.Prompt.BUTTON_TITLE_YES,
              button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
              checkLabel: "",
              checkbox: {},
            });
            if (result != 0) return;
            this.isRunning = true;
            await this.bulkMergeDuplicates();
            this.isRunning = false;
          },
        },
      ],
      ignoreIfExists: true,
    };
  }

  private async bulkMergeDuplicates() {
    const masterItemPref = getPref("bulk.master.item") as MasterItem;
    const { duplicatesObj, duplicateItems } = await fetchDuplicates();
    const processedItems: Set<number> = new Set();
    const popWin = new ztoolkit.ProgressWindow(getString("du-progress-text"), {
      closeOnClick: false,
      closeTime: -1,
    })
      .createLine({
        text: getString("bulk-merge-popup-prepare"),
        type: "default",
        progress: 0,
      })
      .show();

    let toCancel = false;
    const deletedItems: Zotero.Item[] = [];
    let restoreCheckbox: { value: boolean } = { value: false };
    for (let i = 0; i < duplicateItems.length; i++) {
      if (!this._isRunning) {
        const result = Zotero.Prompt.confirm({
          window: this.win,
          title: getString("bulk-merge-suspend-title"),
          text: getString("bulk-merge-suspend-message"),
          button0: getString("bulk-merge-suspend-resume"),
          button1: getString("bulk-merge-suspend-cancel"),
          // button2: getString("bulk-merge-suspend-restore"),
          checkLabel: getString("bulk-merge-suspend-restore"),
          checkbox: restoreCheckbox,
        });
        if (result == 0) {
          restoreCheckbox.value = false;
          this.isRunning = true;
        } else {
          toCancel = true;
          break;
        }
      }
      const duplicateItem = duplicateItems[i];
      if (processedItems.has(duplicateItem)) continue;

      const items: number[] = duplicatesObj.getSetItemsByItemID(duplicateItem);
      const duItems = new DuplicateItems(items, masterItemPref);
      popWin.changeLine({
        text: getString("bulk-merge-popup-process", {
          args: { item: truncateString(duItems.itemTitle) },
        }),
        progress: Math.floor((i / duplicateItems.length) * 100),
      });
      const masterItem = duItems.masterItem;
      const otherItems = duItems.getOtherItems();
      await merge(masterItem, otherItems);
      deletedItems.push(...otherItems);
      items.forEach((id) => processedItems.add(id));
    }

    if (toCancel && restoreCheckbox.value) {
      for (let i = deletedItems.length - 1; i >= 0; i--) {
        const item = deletedItems[i];
        item.deleted = false;
        await item.saveTx();
        popWin.changeLine({
          text: getString("bulk-merge-popup-restore", {
            args: { item: truncateString(item.getField("title")) },
          }),
          progress: Math.floor((i / deletedItems.length) * 100),
        });
      }
    }
    popWin.changeLine({
      text: getString("du-progress-done"),
      type: "success",
      progress: 100,
    });
    popWin.startCloseTimer(5000);
  }

  registerUIElements(win: Window): void {
    this.win = win;
    const msgID = "zoplicate-bulk-merge-message";
    const msgVBox: TagElementProps = {
      tag: "vbox",
      id: msgID,
      properties: {
        textContent: getString("duplicate-panel-message"),
      },
      ignoreIfExists: true,
    };

    ZoteroPane.collectionsView &&
      ZoteroPane.collectionsView.onSelect.addListener(async () => {
        const groupBox = win.document.getElementById("zotero-item-pane-groupbox") as Element;
        if (isInDuplicatesPane()) {
          ztoolkit.UI.appendElement(msgVBox, groupBox);
          ztoolkit.UI.appendElement(this.createBulkMergeButton(win, BulkDuplicates.externalButtonID), groupBox);
          if (this._isRunning && ZoteroPane.itemsView) {
            await ZoteroPane.itemsView.waitForLoad();
            ZoteroPane.itemsView.selection.clearSelection();
          }
        } else {
          const externalButton = win.document.getElementById(BulkDuplicates.externalButtonID);
          if (externalButton) {
            groupBox.removeChild(win.document.getElementById(msgID)!);
            groupBox.removeChild(externalButton);
          }
        }
      });

    ZoteroPane.itemsView &&
      ZoteroPane.itemsView.onRefresh.addListener(() => {
        ztoolkit.log("refresh");
        if (isInDuplicatesPane() && ZoteroPane.itemsView) {
          const disabled = ZoteroPane.itemsView.rowCount <= 0;
          updateButtonDisabled(win!, disabled, BulkDuplicates.innerButtonID, BulkDuplicates.externalButtonID);
          if (this._isRunning) {
            ZoteroPane.itemsView.selection.clearSelection();
          }
        }
      });
  }
}
