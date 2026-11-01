// A startup configuration problem. loadConfig prints the message and exits,
// so messages name the variable and the fix, never a secret value.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
