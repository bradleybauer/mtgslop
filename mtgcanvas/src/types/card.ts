// Canonical card type shared across the app (Scryfall-like card object)
// Reuse the broad shape used by search and services to avoid `any`.
import type { CardLike } from "../search/scryfallQuery";
import type { ScryfallCard } from "../services/scryfall";

// Card is the superset of the two shapes we handle across the app.
// Prefer ScryfallCard fields but allow CardLike for search-only predicates.
export type Card = ScryfallCard & CardLike;

export type CardId = string; // Scryfall id
