// Actions menus open from a small icon button, so the shadcn default (the
// trigger's width) wraps their labels. Every actions menu sizes to its longest
// label instead (owner direction, 2026-10-08, after this was reported twice);
// tests/menus.test.ts keeps each DropdownMenuContent on it.
export const actionsMenuClassName =
  "w-auto min-w-44 max-w-(--available-width) whitespace-nowrap"
