# SVG to Animated Image Converter

A production-ready Node.js tool to convert animated SVG files into multiple animated formats (APNG, GIF, PNG sprite sheet) using a precise frame-by-frame capture strategy.

## Features

- **Multiple Output Formats**: APNG, GIF, and PNG sprite sheets
- **Frame-by-Frame Capture**: Uses Puppeteer to control SVG animation timing precisely
- **Transparency Support**: Preserves transparent backgrounds (APNG & PNG)
- **Smart GIF Optimization**: captures at higher resolution and automatically
  adjusts quality so resulting GIFs stay under ~2.5 MB when possible
- **Batch Processing**: Convert entire folders with subfolder structure preservation
- **Auto-Duration Detection**: Detects animation duration from SVG `dur` attributes
- **Infinite Looping**: Generated animations loop infinitely
- **Progress Tracking**: Real-time console feedback during conversion

## Installation

```bash
npm install
```

This will install:
- `puppeteer` - Headless Chrome for rendering SVG animations
- `ffmpeg-static` - Bundled FFmpeg binary for frame stitching

## Output Formats

| Format | Description | Transparency | Best For |
|--------|-------------|--------------|----------|
| `apng` | Animated PNG | ✅ Yes | High quality, modern browsers |
| `gif` | Animated GIF | ⚠️ Limited | Wide compatibility, sharing |
| `png` | Sprite sheet | ✅ Yes | Game engines, CSS animations |

## Usage

### Command Line

```bash
# Convert to APNG (default)
node index.js animation.svg

# Convert to GIF
node index.js animation.svg --format gif
node index.js animation.svg -F gif

# Convert to PNG sprite sheet
node index.js animation.svg --format png

# Specify output path and options
node index.js animation.svg output.gif --format gif --duration 5 --fps 60
```

### Batch Mode

Process entire folders with preserved subfolder structure:

```bash
# Convert all SVGs in ./input to ./output (APNG)
node index.js --batch

# Convert all to GIF
node index.js --batch --format gif

# Custom folders
node index.js --batch --input ./my-svgs --output ./my-gifs --format gif

# With options
node index.js -b -F gif --fps 24 --duration 3
```

### Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--format` | `-F` | Output format: `apng`, `gif`, `png` | `apng` |
| `--batch` | `-b` | Enable batch mode | - |
| `--input` | `-i` | Input folder for batch mode | `./input` |
| `--output` | `-o` | Output folder for batch mode | `./output` |
| `--duration` | `-d` | Animation duration in seconds | Auto-detect or 3s |
| `--fps` | `-f` | Frames per second (1-120) | 30 |
| `--help` | `-h` | Show help message | - |

### Programmatic Usage

```javascript
import { convertSvg, batchConvert, getSvgAnimationDuration } from './index.js';

// Single file conversion
await convertSvg('input.svg', 'output.gif', 3, 30, 'gif');
await convertSvg('input.svg', 'output.apng', 3, 30, 'apng');
await convertSvg('input.svg', 'sprite.png', 3, 30, 'png');

// Batch conversion
await batchConvert('./input', './output', null, 30, 'gif');

// Auto-detect duration
const duration = await getSvgAnimationDuration('input.svg') || 3;
await convertSvg('input.svg', 'output.gif', duration, 60, 'gif');
```

## Folder Structure (Batch Mode)

The script preserves your input folder structure in the output:

```
input/                          output/ (with --format gif)
├── logo.svg           →        ├── logo.gif
├── icons/                      ├── icons/
│   ├── home.svg       →        │   ├── home.gif
│   └── menu.svg       →        │   └── menu.gif
└── animations/                 └── animations/
    └── subfolder/                  └── subfolder/
        └── loading.svg →               └── loading.gif
```

## How It Works

1. **Load SVG**: The SVG file is loaded into a headless Chrome browser
2. **Pause Animation**: Immediately pauses using `pauseAnimations()`
3. **Capture Frames**: Loops through the timeline, setting `setCurrentTime()` for each frame
4. **Take Screenshots**: Captures each frame with transparent background
5. **Assemble Output**: Uses FFmpeg to create the final animated file
6. **Cleanup**: Removes all temporary frame files

## Performance Tips

- **Lower FPS**: 24-30 FPS is usually sufficient for smooth animations
- **Shorter Duration**: Start with the actual animation loop duration
- **GIF Size**: GIFs can be large; the converter now auto‑reduces quality
  to keep files below 2.5 MB. You can still manually tweak `--quality` or
  `--fps` for finer control
- **Optimize SVG**: Simpler SVGs render faster

## Troubleshooting

### "No SVG element found"
Ensure your SVG file contains a valid `<svg>` root element.

### "Could not get SVG bounding box"
The SVG might have zero dimensions. Add explicit `width` and `height` attributes.

### Large GIF files
GIFs don't compress well. Try:
- Reducing FPS (`--fps 15`)
- Shorter duration
- Smaller SVG dimensions

### Animation not captured correctly
Some CSS animations may not respond to `setCurrentTime()`. This tool works best with SMIL animations (`<animate>`, `<animateTransform>`, etc.).

## Requirements

- Node.js 18+
- ~500MB disk space (for Puppeteer's Chromium)

## License

MIT
