# Read cards from cards.txt
with open('cards.txt', 'r', encoding='utf-8') as f:
    cards = set(line.strip() for line in f if line.strip() and not line.startswith('//'))

# Read owned cards from ownedCards.txt
with open('ownedCards.txt', 'r', encoding='utf-8') as f:
    owned = set(line.strip() for line in f if line.strip() and not line.startswith('//'))

# Compute set difference
not_owned = cards - owned

# Save result to requiredCards.txt
with open('requiredCards.txt', 'w', encoding='utf-8') as f:
    for card in sorted(not_owned):
        f.write(card + '\n')