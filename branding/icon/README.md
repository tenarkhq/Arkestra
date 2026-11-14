# Arkestra app icon

The chosen direction is 1 · Kristály, a trillion-cut gem lit from the top.
`gen.py` draws all four candidate directions (`defs.svg`), and the chosen one as `k.svg` (large) and `k_s.svg` (the hand-drawn small version for 32 px and below).

To rebuild the icons:

1. `python3 gen.py`
2. Render `k.svg` and `k_s.svg` to `out/k-1024.png` and `out/k_s-1024.png`, 1024 px with a transparent background (any headless Chromium screenshot).
3. `python3 pack.py` (needs Pillow). This writes `assets/` with the macOS icns, the Windows ico, the tiles and installer images, the Linux png, svg and xpm, the web icons, the title-bar icon and the empty-editor watermarks.
4. Copy `assets/.` into `branding/overlay/`. The overlay replaces VSCodium's files after prepare.
