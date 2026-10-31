# GameMonetize starter catalogue

`gamemonetize-games.json` is a small, hand-selected snapshot of GameMonetize's public [JSON game feed](https://rss.gamemonetize.com/rssfeed.php?format=json&category=All&type=html5&popularity=newest&company=All&amount=100), consulted on 31 October 2026. The initial 32 titles were selected across several categories; some descriptions and controls were shortened for readability. Artwork and games remain hosted by GameMonetize, not by KORASTORE. Their content, availability, device support and advertising can change.

The `id` is the 32-character game identifier in the provider's embed URL, rather than the feed's numeric ID. It keeps player links stable across feed imports. `url` is the provider's embed URL, `thumb` its matching artwork, and `width`/`height` describe the game's aspect ratio. Only matching GameMonetize HTTPS hosts are accepted by the importer and player.

See **Browser games** in the root README for publisher setup, manual refresh commands and the need to review games and test monetization on the approved live domain. Feed updates are not automatically moderated; remove any content unsuitable for your audience before deploying.
