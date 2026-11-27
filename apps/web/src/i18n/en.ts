export const enMessages = {
  "app.name": "Prood",
  "app.tagline": "Tasks and knowledge shared by humans and AI agents",
  "nav.list": "List",
  "nav.board": "Board",
  "nav.search": "Search",
  "action.createTask": "Create task",
  "action.copyId": "Copy ID",
  "action.copyKey": "Copy key",
  "empty.tasks.title": "No tasks yet",
  "empty.tasks.description": "Create your first task to collaborate with agents.",
  "error.generic": "Something went wrong. Please try again.",
  "error.forbidden": "You do not have permission to perform this action.",
  "error.notFound": "The requested item was not found.",
  "error.conflict": "A conflict occurred while updating this item.",
  "aria.mainNavigation": "Main navigation",
  "aria.taskList": "Task list",
  "aria.searchTasks": "Search tasks",
  "aria.copyPublicId": "Copy public task ID {id}",
  "task.count.one": "{count} task",
  "task.count.other": "{count} tasks",
} as const;

export type MessageKey = keyof typeof enMessages;
export type MessageCatalog = Record<MessageKey, string>;
export type PartialMessageCatalog = Partial<MessageCatalog>;
