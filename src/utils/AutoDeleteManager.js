import { EVENTS } from "../events.js";

const FLAGGED_SELECTOR = "div[data-testid='cellInnerDiv'][data-ghosted]";
const ARTICLE_SELECTOR = "article[data-testid='tweet']";
const CARET_SELECTORS = [
  "button[aria-label='More']",
  "div[aria-label='More']",
  "button[data-testid='caret']",
  "div[data-testid='caret']",
];
const MENUITEM_SELECTOR = "[role='menuitem']";
const CONFIRM_SELECTOR = "button[data-testid='confirmationSheetConfirm']";
const PROBLEM_MARKERS = [
  "postquality.problem",
  "postquality.problem-adjacent",
  "postquality.potential-problem",
];

const DEFAULT_CONFIG = {
  WAIT_BETWEEN_STEPS: 400,
  WAIT_AFTER_DELETE: 500,
  SCAN_INTERVAL: 4000,
  MENU_ATTEMPTS: 4,
  CONFIRM_ATTEMPTS: 4,
};

export class AutoDeleteManager {
  constructor({
    document,
    window,
    log,
    domUtils,
    emit,
    getUsername,
    isWithReplies,
    config = {},
  }) {
    this.document = document;
    this.window = window;
    this.log = log || (() => {});
    this.domUtils = domUtils;
    this.emit = emit;
    this.getUsername = getUsername;
    this.isWithReplies = isWithReplies;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      running: false,
      deleting: false,
      deletedCount: 0,
      lastError: null,
    };
    this.loopHandle = null;
  }

  handleToggle(enabled) {
    if (enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  start() {
    if (this.state.running) {
      return;
    }
    if (!this.canOperate()) {
      this.state.lastError = this.getUnavailableReason();
      this.emitStatus();
      return;
    }
    this.state.running = true;
    this.state.deletedCount = 0;
    this.state.lastError = null;
    this.log(`[AutoDelete] Started for @${this.getNormalizedUsername()}`);
    this.ensureLoop();
    this.emitStatus();
    void this.runCycle();
  }

  stop(reason) {
    if (!this.state.running) {
      this.state.lastError = reason || this.state.lastError;
      this.emitStatus();
      return;
    }
    this.state.running = false;
    if (reason) {
      this.state.lastError = reason;
    }
    this.clearLoop();
    this.log("[AutoDelete] Stopped");
    this.emitStatus();
  }

  destroy() {
    this.clearLoop();
  }

  handleContextChange() {
    if (this.state.running && !this.canOperate()) {
      this.stop(this.getUnavailableReason());
      return;
    }
    this.emitStatus();
  }

  ensureLoop() {
    if (this.loopHandle) {
      return;
    }
    this.loopHandle = this.window.setInterval(() => {
      void this.runCycle();
    }, this.config.SCAN_INTERVAL);
  }

  clearLoop() {
    if (this.loopHandle) {
      this.window.clearInterval(this.loopHandle);
      this.loopHandle = null;
    }
  }

  async runCycle() {
    if (!this.state.running || this.state.deleting) {
      return;
    }
    if (!this.canOperate()) {
      this.stop(this.getUnavailableReason());
      return;
    }
    const article = this.findFirstFlaggedArticle();
    if (!article) {
      return;
    }
    this.state.deleting = true;
    this.emitStatus();
    try {
      const deleted = await this.deleteArticle(article);
      if (deleted) {
        this.state.deletedCount += 1;
        this.log(
          `[AutoDelete] Deleted flagged post #${this.state.deletedCount}`
        );
      }
    } catch (error) {
      this.log(`[AutoDelete] Error deleting post: ${error?.message || error}`);
      this.state.lastError = error?.message || String(error);
    } finally {
      this.state.deleting = false;
      this.emitStatus();
    }
  }

  async deleteArticle(article) {
    const caret = await this.findCaretWithRetry(article);
    if (!caret) {
      this.log("[AutoDelete] Caret button not found");
      return false;
    }
    caret.click();
    await this.delay(this.config.WAIT_BETWEEN_STEPS);
    const deleteClicked = await this.tryClickDeleteMenuItem();
    if (!deleteClicked) {
      this.log("[AutoDelete] Delete menu item not clicked");
      return false;
    }
    const confirmed = await this.tryConfirmDelete();
    if (!confirmed) {
      this.log("[AutoDelete] Confirm delete button not found");
      return false;
    }
    await this.delay(this.config.WAIT_AFTER_DELETE);
    return true;
  }

  findFirstFlaggedArticle() {
    const flaggedCells = this.getAllFlaggedCells();
    for (const cell of flaggedCells) {
      const article = this.getTargetArticleFromCell(cell);
      if (article) {
        return article;
      }
    }
    return null;
  }

  getAllFlaggedCells() {
    const nodes = Array.from(
      this.document.querySelectorAll(FLAGGED_SELECTOR)
    );
    return nodes.filter((node) => {
      const ghost = (node.getAttribute("data-ghosted") || "").toLowerCase();
      return PROBLEM_MARKERS.some((marker) => ghost.includes(marker));
    });
  }

  getTargetArticleFromCell(cell) {
    const articles = Array.from(cell.querySelectorAll(ARTICLE_SELECTOR));
    return articles.find((article) => this.isTweetByUser(article)) || null;
  }

  isTweetByUser(article) {
    const username = this.getNormalizedUsername();
    if (!article || !username) {
      return false;
    }
    const links = Array.from(article.querySelectorAll("a[href^='/']"));
    for (const link of links) {
      const href = (link.getAttribute("href") || "").toLowerCase();
      if (!href.startsWith("/")) {
        continue;
      }
      if (href === `/${username}` || href.startsWith(`/${username}/`)) {
        const repostMarker = article.querySelector(
          "button[data-testid='unretweet']"
        );
        if (repostMarker) {
          return false;
        }
        return true;
      }
    }
    return false;
  }

  async findCaretWithRetry(article, maxRetries = 5, delayMs = 250) {
    for (let i = 0; i < maxRetries; i++) {
      const caret = CARET_SELECTORS.map((selector) =>
        article.querySelector(selector)
      ).find((el) => this.isVisible(el));
      if (caret) {
        return caret;
      }
      await this.delay(delayMs);
    }
    return null;
  }

  async tryClickDeleteMenuItem() {
    for (let attempt = 0; attempt < this.config.MENU_ATTEMPTS; attempt++) {
      await this.delay(this.config.WAIT_BETWEEN_STEPS * (attempt + 1));
      const menuItems = this.document.querySelectorAll(MENUITEM_SELECTOR);
      for (const item of menuItems) {
        const label = (item.innerText || "").toLowerCase();
        if (label.includes("delete")) {
          item.click();
          return true;
        }
      }
    }
    return false;
  }

  async tryConfirmDelete() {
    for (
      let attempt = 0;
      attempt < this.config.CONFIRM_ATTEMPTS;
      attempt++
    ) {
      await this.delay(this.config.WAIT_BETWEEN_STEPS * (attempt + 1));
      const confirmBtn = this.document.querySelector(CONFIRM_SELECTOR);
      if (this.isVisible(confirmBtn)) {
        confirmBtn.click();
        return true;
      }
    }
    return false;
  }

  canOperate() {
    return Boolean(this.getNormalizedUsername()) && this.isOnRepliesPage();
  }

  isOnRepliesPage() {
    const username = this.getNormalizedUsername();
    if (!username) {
      return false;
    }
    const pathname = this.window.location.pathname.toLowerCase();
    return (
      this.isWithReplies() && pathname.startsWith(`/${username}`) && pathname.endsWith("/with_replies")
    );
  }

  getUnavailableReason() {
    if (!this.getNormalizedUsername()) {
      return "Open your profile's /with_replies page to capture the username.";
    }
    if (!this.isWithReplies()) {
      return "Auto delete is only available on the /with_replies view.";
    }
    return "Navigate to your own /with_replies page to enable auto delete.";
  }

  emitStatus() {
    const detail = {
      running: this.state.running,
      deleting: this.state.deleting,
      deletedCount: this.state.deletedCount,
      username: this.getNormalizedUsername() || null,
      canRun: this.canOperate(),
      message: this.state.lastError || this.composeMessage(),
    };
    this.emit(EVENTS.AUTO_DELETE_STATUS, detail);
  }

  composeMessage() {
    if (!this.getNormalizedUsername()) {
      return "Open a /with_replies page to detect your username.";
    }
    if (!this.isWithReplies()) {
      return "Auto delete becomes available on /with_replies.";
    }
    if (this.state.deleting) {
      return "Deleting a flagged reply...";
    }
    if (this.state.running) {
      return "Scanning flagged replies...";
    }
    return "Ready to delete flagged replies.";
  }

  getNormalizedUsername() {
    const raw = (this.getUsername?.() || "").trim().replace(/^@/, "");
    return raw.toLowerCase();
  }

  isVisible(el) {
    return Boolean(
      el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    );
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
