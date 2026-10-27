import { vendors } from "./fixtures";

/** The Acme Cloud registry vendor (a legitimate payee for the self-test). */
export function fixtureAcme() {
  return vendors().find((v) => v.key === "acme")!;
}
