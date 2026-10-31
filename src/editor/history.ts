/** Snapshot-based undo/redo. `push(prev)` records the state BEFORE a change. */
export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  constructor(private limit = 200) {}

  push(prev: T) {
    this.undoStack.push(prev);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  /** Returns the state to restore (and remembers `current` for redo), or null. */
  undo(current: T): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(current);
    return prev;
  }
  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    return next;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
