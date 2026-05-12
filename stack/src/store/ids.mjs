let counter = 1;
export function newId(prefix = "c") { return `${prefix}-${counter++}`; }
export function resetIds() { counter = 1; }
