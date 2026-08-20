/**
 * Base class for every domain error in the Order-To-Cash trilogy.
 *
 * A domain error (see `specs/shared/requirements.md` vocabulary) is a
 * refusal raised inside the domain layer: it carries a stable
 * machine-readable `code`, changes no state and emits no fact. Every
 * concrete error extends this class and supplies its own `code`.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain broken by transpiling `Error` subclasses
    // down to ES5-style constructors (target is ES2023 here, but this is
    // cheap insurance and makes `instanceof` checks reliable regardless).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
