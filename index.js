import puppeteer from 'puppeteer';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default folders
const DEFAULT_INPUT_FOLDER = path.join(__dirname, 'input');
const DEFAULT_OUTPUT_FOLDER = path.join(__dirname, 'output');

// Supported output formats
const SUPPORTED_FORMATS = ['apng', 'gif', 'png'];
const DEFAULT_FORMAT = 'apng';

// Quality presets for GIF optimization (targeting max ~2.5MB for article use)
// ─────────────────────────────────────────────────────────────────────────────
//  Key levers that fight blur:
//    scale      → higher = sharper, more detail preserved
//    colors     → 256 = full GIF palette, richer gradients
//    dither     → floyd_steinberg smooths gradients; sierra2_4a is slightly
//                 faster but equally good for most shapes
//    statsMode  → 'full' builds one palette from ALL frames → consistent
//                 colors, no per-frame color popping or washout
//    unsharp    → FFmpeg unsharp mask (luma radius:sigma:amount:chroma r:s:a)
//                 adds a gentle edge-enhancement pass after downscaling
// ─────────────────────────────────────────────────────────────────────────────
const GIF_QUALITY_PRESETS = {
  // Crisp, vibrant — best for hero/feature GIFs in articles (~2–2.5MB)
  high: {
    scale: 900,
    colors: 256,
    fps: 22,
    dither: 'floyd_steinberg',
    bayerScale: 5,
    statsMode: 'full',
    unsharp: '5:5:0.8:3:3:0.0',
  },
  // Great balance of sharpness & size — ideal default for inline article GIFs (~1–2MB)
  medium: {
    scale: 780,
    colors: 256,
    fps: 18,
    dither: 'sierra2_4a',
    bayerScale: 4,
    statsMode: 'full',
    unsharp: '3:3:0.6:3:3:0.0',
  },
  // Compact but still readable — for thumbnails or high-frame-count animations (~500KB–1MB)
  low: {
    scale: 600,
    colors: 192,
    fps: 15,
    dither: 'sierra2_4a',
    bayerScale: 3,
    statsMode: 'diff',
    unsharp: '3:3:0.4:3:3:0.0',
  },
};
const DEFAULT_QUALITY = 'medium';

/**
 * Converts an animated SVG file to various animated formats (APNG, GIF, PNG sprite)
 * using a frame-by-frame capture strategy for precise animation control.
 *
 * @param {string} inputPath - Path to the input SVG file
 * @param {string} outputPath - Path for the output file
 * @param {number} duration - Animation duration in seconds
 * @param {number} fps - Frames per second (default: 30)
 * @param {string} format - Output format: 'apng', 'gif', or 'png' (default: 'apng')
 * @param {string} quality - Quality preset for GIF: 'high', 'medium', 'low' (default: 'medium')
 * @returns {Promise<void>}
 */
async function convertSvg(inputPath, outputPath, duration, fps = 30, format = 'apng', quality = 'medium') {
  // Validate format
  const normalizedFormat = format.toLowerCase();
  if (!SUPPORTED_FORMATS.includes(normalizedFormat)) {
    throw new Error(`Unsupported format: ${format}. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`);
  }

  // For GIF, apply quality preset to FPS if not explicitly set differently
  let effectiveFps = fps;
  const qualityPreset = GIF_QUALITY_PRESETS[quality] || GIF_QUALITY_PRESETS.medium;
  if (normalizedFormat === 'gif' && fps === 30) {
    // Use quality preset FPS for GIF (default 30 means user didn't override)
    effectiveFps = qualityPreset.fps;
  }
  const absoluteInputPath = path.resolve(inputPath);
  const absoluteOutputPath = path.resolve(outputPath);
  const tempDir = path.join(__dirname, `.temp-frames-${Date.now()}`);
  
  let browser = null;

  try {
    // Validate input file exists
    await fs.access(absoluteInputPath);
    console.log(`📂 Input file: ${absoluteInputPath}`);
    console.log(`📂 Output file: ${absoluteOutputPath}`);
    console.log(`📦 Format: ${normalizedFormat.toUpperCase()}${normalizedFormat === 'gif' ? ` (quality: ${quality})` : ''}`);
    console.log(`⏱️  Duration: ${duration}s | FPS: ${effectiveFps}`);

    // Calculate total frames
    const totalFrames = Math.ceil(duration * effectiveFps);
    console.log(`🎞️  Total frames to capture: ${totalFrames}`);

    // Create temporary directory for frames
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`📁 Created temp directory: ${tempDir}`);

    // Read SVG content
    const svgContent = await fs.readFile(absoluteInputPath, 'utf-8');

    // Launch Puppeteer
    console.log('🚀 Launching headless browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Set viewport (adjust as needed based on your SVG dimensions)
    await page.setViewport({
      width: 1024,
      height: 1024,
      deviceScaleFactor: 1,
    });

    // Create HTML page with the SVG embedded
    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            html, body {
              width: 100%;
              height: 100%;
              background: transparent;
              display: flex;
              justify-content: center;
              align-items: center;
            }
            svg {
              max-width: 100%;
              max-height: 100%;
            }
          </style>
        </head>
        <body>
          ${svgContent}
        </body>
      </html>
    `;

    // Load the HTML content
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    console.log('📄 SVG loaded into page');

    // Get the SVG element
    const svgElement = await page.$('svg');
    if (!svgElement) {
      throw new Error('No SVG element found in the document');
    }

    // Pause the animation immediately
    await page.evaluate(() => {
      const svg = document.querySelector('svg');
      if (svg && typeof svg.pauseAnimations === 'function') {
        svg.pauseAnimations();
      }
    });
    console.log('⏸️  Animation paused');

    // Get SVG bounding box for precise screenshots
    const boundingBox = await svgElement.boundingBox();
    if (!boundingBox) {
      throw new Error('Could not get SVG bounding box');
    }

    console.log(`📐 SVG dimensions: ${Math.round(boundingBox.width)}x${Math.round(boundingBox.height)}`);
    console.log('📸 Starting frame capture...\n');

    // Capture frames
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      // Calculate time to evenly distribute frames across the full duration
      // Frame 0 = 0s, Last frame = duration
      const timeInSeconds = totalFrames > 1 
        ? (frameIndex / (totalFrames - 1)) * duration 
        : 0;
      
      // Set the animation time
      await page.evaluate((time) => {
        const svg = document.querySelector('svg');
        if (svg && typeof svg.setCurrentTime === 'function') {
          svg.setCurrentTime(time);
        }
      }, timeInSeconds);

      // Small delay to ensure rendering is complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // Generate frame filename with zero-padding
      const frameNumber = String(frameIndex + 1).padStart(4, '0');
      const framePath = path.join(tempDir, `frame_${frameNumber}.png`);

      // Take screenshot with transparency
      await svgElement.screenshot({
        path: framePath,
        omitBackground: true,
      });

      // Progress logging
      const progress = Math.round(((frameIndex + 1) / totalFrames) * 100);
      process.stdout.write(`\r🎬 Capturing frame ${frameIndex + 1}/${totalFrames} (${progress}%)`);
    }

    console.log('\n\n✅ Frame capture complete!');

    // Close browser
    await browser.close();
    browser = null;
    console.log('🔒 Browser closed');

    // Ensure output directory exists
    const outputDir = path.dirname(absoluteOutputPath);
    await fs.mkdir(outputDir, { recursive: true });

    // Use FFmpeg to create output file
    console.log(`🔧 Assembling ${normalizedFormat.toUpperCase()} with FFmpeg...`);
    await createOutputWithFfmpeg(tempDir, absoluteOutputPath, effectiveFps, normalizedFormat, qualityPreset);

    console.log(`\n🎉 Success! ${normalizedFormat.toUpperCase()} saved to: ${absoluteOutputPath}`);

  } catch (error) {
    console.error('\n❌ Error during conversion:', error.message);
    throw error;
  } finally {
    // Cleanup: close browser if still open
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn('⚠️  Warning: Could not close browser:', e.message);
      }
    }

    // Cleanup: remove temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log('🧹 Cleaned up temporary files');
    } catch (e) {
      console.warn(`⚠️  Warning: Could not clean up temp directory: ${e.message}`);
    }
  }
}

/**
 * Creates output file from a sequence of PNG frames using FFmpeg.
 *
 * GIF quality pipeline (why each step matters):
 *   1. scale with lanczos + accurate_rnd + full_chroma_int
 *      → highest-quality downscale; avoids the soft/blurry look from bilinear
 *   2. unsharp mask
 *      → recovers edge crispness lost during downscaling — essential for text
 *         and fine lines common in article graphics
 *   3. palettegen with stats_mode=full
 *      → analyses EVERY frame to build one optimal palette instead of
 *         per-frame palettes; prevents colour shifting / washout between frames
 *   4. paletteuse with floyd_steinberg or sierra2_4a dithering
 *      → smooth gradients without harsh bayer checkerboard patterns
 *   5. diff_mode=rectangle
 *      → only encodes changed pixel regions per frame, cutting file size
 *         without sacrificing visual quality
 *
 * @param {string} framesDir - Directory containing the frame images
 * @param {string} outputPath - Output file path
 * @param {number} fps - Frames per second
 * @param {string} format - Output format: 'apng', 'gif', or 'png'
 * @param {object} qualityPreset - Quality settings for GIF
 * @returns {Promise<void>}
 */
function createOutputWithFfmpeg(framesDir, outputPath, fps, format, qualityPreset = {}) {
  return new Promise((resolve, reject) => {
    const inputPattern = path.join(framesDir, 'frame_%04d.png');
    let args;

    switch (format) {
      case 'apng':
        // APNG: Animated PNG with infinite loop
        args = [
          '-framerate', String(fps),
          '-i', inputPattern,
          '-plays', '0',           // Infinite loop
          '-f', 'apng',
          '-y',
          outputPath,
        ];
        break;

      case 'gif': {
        // ── GIF: High-quality, article-ready, under 2.5 MB ──────────────────
        const {
          scale = 780,
          colors = 256,
          dither = 'sierra2_4a',
          bayerScale = 4,
          statsMode = 'full',     // 'full' = consistent palette across all frames
          unsharp = '3:3:0.6:3:3:0.0',
        } = qualityPreset;

        // Build dither clause
        let ditherClause;
        if (dither === 'bayer') {
          ditherClause = `dither=bayer:bayer_scale=${bayerScale}:diff_mode=rectangle`;
        } else {
          ditherClause = `dither=${dither}:diff_mode=rectangle`;
        }

        // Full filter chain:
        //   scale (lanczos, high-quality flags)
        //   → unsharp (restore edge crispness)
        //   → split → palettegen (stats_mode=full for stable colours)
        //           → paletteuse (smooth dither)
        const filterComplex = [
          `scale=${scale}:-1:flags=lanczos+accurate_rnd+full_chroma_int`,
          `unsharp=${unsharp}`,
          `split[s0][s1]`,
          `[s0]palettegen=max_colors=${colors}:stats_mode=${statsMode}[p]`,
          `[s1][p]paletteuse=${ditherClause}`,
        ].join(',');
        // Note: the split/palettegen/paletteuse must use filter_complex syntax
        // so we restructure as a proper graph:
        const filterGraph =
          `scale=${scale}:-1:flags=lanczos+accurate_rnd+full_chroma_int,` +
          `unsharp=${unsharp},` +
          `split[s0][s1];` +
          `[s0]palettegen=max_colors=${colors}:stats_mode=${statsMode}[p];` +
          `[s1][p]paletteuse=${ditherClause}`;

        args = [
          '-framerate', String(fps),
          '-i', inputPattern,
          '-filter_complex', filterGraph,
          '-loop', '0',            // Infinite loop
          '-y',
          outputPath,
        ];
        break;
      }

      case 'png':
        // PNG: Create a vertical sprite sheet (all frames stacked)
        args = [
          '-framerate', String(fps),
          '-i', inputPattern,
          '-filter_complex', 'tile=1x0',
          '-y',
          outputPath,
        ];
        break;

      default:
        reject(new Error(`Unsupported format: ${format}`));
        return;
    }

    console.log(`📍 FFmpeg path: ${ffmpegPath}`);
    console.log(`📍 Running: ffmpeg ${args.join(' ')}`);

    const ffmpeg = spawn(ffmpegPath, args);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}:\n${stderr}`));
      }
    });

    ffmpeg.on('error', (error) => {
      reject(new Error(`FFmpeg spawn error: ${error.message}`));
    });
  });
}

/**
 * Parse a time value from SVG (supports "2s", "500ms", "1.5")
 *
 * @param {string} value - Time value string
 * @returns {number} Time in seconds
 */
function parseTimeValue(value) {
  if (!value || value === 'indefinite') return 0;
  
  const trimmed = value.trim();
  
  if (trimmed.endsWith('ms')) {
    return parseFloat(trimmed) / 1000;
  } else if (trimmed.endsWith('s')) {
    return parseFloat(trimmed);
  } else {
    // Plain number is treated as seconds
    return parseFloat(trimmed) || 0;
  }
}

/**
 * Get SVG animation duration by analyzing the SVG content
 * Calculates the total animation timeline by finding the maximum (begin + dur)
 *
 * @param {string} svgPath - Path to SVG file
 * @returns {Promise<number|null>} Duration in seconds, or null if not found
 */
async function getSvgAnimationDuration(svgPath) {
  try {
    const content = await fs.readFile(svgPath, 'utf-8');
    
    let maxEndTime = 0;
    
    // Find all animate, animateTransform, animateMotion, set elements
    const animateRegex = /<(?:animate|animateTransform|animateMotion|set)[^>]*>/gi;
    const animateElements = content.match(animateRegex) || [];
    
    for (const element of animateElements) {
      const beginMatch = element.match(/begin\s*=\s*["']([^"']+)["']/i);
      let beginTime = 0;
      
      if (beginMatch) {
        const beginValue = beginMatch[1];
        if (!beginValue.includes('.') || beginValue.match(/^\d/)) {
          const beginParts = beginValue.split(';');
          const lastBegin = beginParts[beginParts.length - 1].trim();
          if (/^[\d.]+(?:m?s)?$/.test(lastBegin)) {
            beginTime = parseTimeValue(lastBegin);
          }
        }
      }
      
      const durMatch = element.match(/dur\s*=\s*["']([^"']+)["']/i);
      let durTime = 0;
      
      if (durMatch && durMatch[1] !== 'indefinite') {
        durTime = parseTimeValue(durMatch[1]);
      }
      
      const endTime = beginTime + durTime;
      if (endTime > maxEndTime) {
        maxEndTime = endTime;
      }
    }
    
    // Also check for CSS animations with animation-duration
    const cssAnimDurMatch = content.match(/animation-duration\s*:\s*([\d.]+)(?:m?s)?/gi);
    if (cssAnimDurMatch) {
      for (const match of cssAnimDurMatch) {
        const durMatch = match.match(/([\d.]+)(m?s)?/);
        if (durMatch) {
          const value = parseFloat(durMatch[1]);
          const unit = durMatch[2] || 's';
          const seconds = unit === 'ms' ? value / 1000 : value;
          if (seconds > maxEndTime) {
            maxEndTime = seconds;
          }
        }
      }
    }
    
    // Check if there are indefinite/repeating animations
    const hasIndefiniteAnimations = /repeatCount\s*=\s*["']indefinite["']/i.test(content) ||
                                    /animation-iteration-count\s*:\s*infinite/i.test(content);
    
    if (hasIndefiniteAnimations && maxEndTime > 0 && maxEndTime < 5) {
      maxEndTime = Math.max(Math.ceil(maxEndTime) + 2, 5);
    }
    
    return maxEndTime > 0 ? maxEndTime : null;
  } catch (error) {
    console.warn('Could not parse SVG duration:', error.message);
    return null;
  }
}


/**
 * Recursively finds all SVG files in a directory
 *
 * @param {string} dir - Directory to search
 * @param {string} baseDir - Base directory for relative path calculation
 * @returns {Promise<Array<{absolute: string, relative: string}>>}
 */
async function findSvgFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, absolutePath);

    if (entry.isDirectory()) {
      const subFiles = await findSvgFiles(absolutePath, baseDir);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
      files.push({ absolute: absolutePath, relative: relativePath });
    }
  }

  return files;
}

/**
 * Batch converts all SVG files from input folder to output folder
 * Preserves subfolder structure
 *
 * @param {string} inputFolder - Input folder containing SVG files
 * @param {string} outputFolder - Output folder for output files
 * @param {number|null} duration - Animation duration (null for auto-detect)
 * @param {number} fps - Frames per second
 * @param {string} format - Output format: 'apng', 'gif', or 'png'
 * @param {string} quality - Quality preset for GIF: 'high', 'medium', 'low'
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
async function batchConvert(inputFolder, outputFolder, duration = null, fps = 30, format = 'apng', quality = 'medium') {
  const absoluteInputFolder = path.resolve(inputFolder);
  const absoluteOutputFolder = path.resolve(outputFolder);
  const normalizedFormat = format.toLowerCase();

  console.log('\n' + '═'.repeat(60));
  console.log(`       SVG to ${normalizedFormat.toUpperCase()} Batch Converter - Starting`);
  console.log('═'.repeat(60));
  console.log(`\n📂 Input folder:  ${absoluteInputFolder}`);
  console.log(`📂 Output folder: ${absoluteOutputFolder}`);
  console.log(`📦 Format: ${normalizedFormat.toUpperCase()}${normalizedFormat === 'gif' ? ` (quality: ${quality})` : ''}\n`);

  try {
    await fs.access(absoluteInputFolder);
  } catch {
    throw new Error(`Input folder does not exist: ${absoluteInputFolder}`);
  }

  await fs.mkdir(absoluteOutputFolder, { recursive: true });

  console.log('🔍 Scanning for SVG files...');
  const svgFiles = await findSvgFiles(absoluteInputFolder);

  if (svgFiles.length === 0) {
    console.log('⚠️  No SVG files found in input folder');
    return { success: 0, failed: 0, errors: [] };
  }

  console.log(`📋 Found ${svgFiles.length} SVG file(s)\n`);

  const results = { success: 0, failed: 0, errors: [] };

  for (let i = 0; i < svgFiles.length; i++) {
    const { absolute: inputPath, relative: relativePath } = svgFiles[i];
    
    const relativeDir = path.dirname(relativePath);
    const baseName = path.basename(relativePath, '.svg');
    const outputDir = path.join(absoluteOutputFolder, relativeDir);
    const outputPath = path.join(outputDir, `${baseName}.${normalizedFormat}`);

    console.log('─'.repeat(60));
    console.log(`📄 [${i + 1}/${svgFiles.length}] Processing: ${relativePath}`);

    try {
      await fs.mkdir(outputDir, { recursive: true });

      let fileDuration = duration;
      if (!fileDuration) {
        const detected = await getSvgAnimationDuration(inputPath);
        fileDuration = detected || 3;
        console.log(`   ⏱️  Duration: ${fileDuration}s ${detected ? '(auto-detected)' : '(default)'}`);
      }

      await convertSvg(inputPath, outputPath, fileDuration, fps, normalizedFormat, quality);
      results.success++;

    } catch (error) {
      console.error(`   ❌ Failed: ${error.message}`);
      results.failed++;
      results.errors.push({ file: relativePath, error: error.message });
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('                    Batch Conversion Complete');
  console.log('═'.repeat(60));
  console.log(`\n✅ Successful: ${results.success}`);
  console.log(`❌ Failed: ${results.failed}`);
  
  if (results.errors.length > 0) {
    console.log('\n📋 Failed files:');
    results.errors.forEach(({ file, error }) => {
      console.log(`   - ${file}: ${error}`);
    });
  }

  console.log(`\n📂 Output saved to: ${absoluteOutputFolder}\n`);

  return results;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║        SVG to Animated Image Converter - Frame by Frame      ║
╚══════════════════════════════════════════════════════════════╝

Usage:

  SINGLE FILE MODE:
    node index.js <input.svg> [output] [options]

  BATCH MODE (process entire folders):
    node index.js --batch [options]
    node index.js -b [options]

Arguments:
  input.svg              Path to the input animated SVG file
  output                 Path for the output file (extension based on format)

Options:
  --format, -F <type>    Output format: apng, gif, png (default: apng)
  --quality, -q <level>  GIF quality: high, medium, low (default: medium)
  --batch, -b            Enable batch mode (process input/ folder)
  --input, -i <folder>   Input folder for batch mode (default: ./input)
  --output, -o <folder>  Output folder for batch mode (default: ./output)
  --duration, -d <sec>   Animation duration in seconds (default: auto-detect or 3)
  --fps, -f <number>     Frames per second (default: 30, auto-adjusted for GIF)
  --help, -h             Show this help message

Output Formats:
  apng                   Animated PNG - best quality, transparency support
  gif                    Animated GIF - optimised for article use (sharp, <2.5MB)
  png                    PNG sprite sheet - all frames stacked vertically

GIF Quality Presets (all target <2.5MB, article-ready sharpness):
  high    900px wide, 256 colours, 22fps — hero/feature images  (~2–2.5MB)
  medium  780px wide, 256 colours, 18fps — inline article GIFs  (~1–2MB)  ← default
  low     600px wide, 192 colours, 15fps — thumbnails / many frames (~500KB–1MB)

  All presets use:
    • Lanczos downscaling (accurate_rnd + full_chroma_int flags)
    • Unsharp mask — restores edge crispness after downscale
    • stats_mode=full (high/medium) — stable palette across all frames,
      prevents colour washout between frames
    • floyd_steinberg / sierra2_4a dithering — smooth gradients,
      no checkerboard artefacts

Examples:
  # Single file — APNG (lossless, best quality)
  node index.js animation.svg
  node index.js animation.svg output.apng --duration 5 --fps 60

  # Single file — GIF medium (recommended for most articles)
  node index.js animation.svg --format gif
  node index.js animation.svg -F gif -q high   # Hero image, max quality

  # Single file — GIF smallest size
  node index.js animation.svg -F gif -q low

  # Batch — convert all SVGs to GIF
  node index.js --batch --format gif
  node index.js -b -F gif -q medium

  # Batch with custom folders
  node index.js --batch --input ./my-svgs --output ./my-gifs -F gif -q high

Folder Structure (Batch Mode):
  input/                          output/ (with --format gif)
    ├── logo.svg           →        ├── logo.gif
    ├── icons/                      ├── icons/
    │   ├── home.svg       →        │   ├── home.gif
    │   └── menu.svg       →        │   └── menu.gif
    └── animations/                 └── animations/
        └── loading.svg    →            └── loading.gif
    `);
    process.exit(0);
  }

  // Check for batch mode
  const isBatchMode = args.includes('--batch') || args.includes('-b');

  // Parse common options
  let duration = null;
  let fps = 30;
  let format = DEFAULT_FORMAT;
  let quality = DEFAULT_QUALITY;
  let inputFolder = DEFAULT_INPUT_FOLDER;
  let outputFolder = DEFAULT_OUTPUT_FOLDER;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--duration' || arg === '-d') {
      duration = parseFloat(args[++i]);
    } else if (arg === '--fps' || arg === '-f') {
      fps = parseInt(args[++i], 10);
    } else if (arg === '--format' || arg === '-F') {
      format = args[++i]?.toLowerCase();
    } else if (arg === '--quality' || arg === '-q') {
      quality = args[++i]?.toLowerCase();
    } else if (arg === '--input' || arg === '-i') {
      inputFolder = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      outputFolder = args[++i];
    }
  }

  // Validate format
  if (!SUPPORTED_FORMATS.includes(format)) {
    console.error(`❌ Error: Unsupported format "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}`);
    process.exit(1);
  }

  // Validate quality
  if (!GIF_QUALITY_PRESETS[quality]) {
    console.error(`❌ Error: Unsupported quality "${quality}". Supported: high, medium, low`);
    process.exit(1);
  }

  // Validate FPS
  if (isNaN(fps) || fps <= 0 || fps > 120) {
    console.error('❌ Error: FPS must be a positive number (max 120)');
    process.exit(1);
  }

  if (isBatchMode) {
    try {
      const results = await batchConvert(inputFolder, outputFolder, duration, fps, format, quality);
      process.exit(results.failed > 0 ? 1 : 0);
    } catch (error) {
      console.error('\n❌ Batch conversion failed:', error.message);
      process.exit(1);
    }
  } else {
    // Single file mode
    const nonFlagArgs = args.filter((arg, i) => {
      if (arg.startsWith('-')) return false;
      const prevArg = args[i - 1];
      if (prevArg === '--duration' || prevArg === '-d' ||
          prevArg === '--fps' || prevArg === '-f' ||
          prevArg === '--format' || prevArg === '-F' ||
          prevArg === '--quality' || prevArg === '-q' ||
          prevArg === '--input' || prevArg === '-i' ||
          prevArg === '--output' || prevArg === '-o') {
        return false;
      }
      return true;
    });

    if (nonFlagArgs.length === 0) {
      console.log('ℹ️  No input file specified. Use --help for usage information.');
      console.log('   Or use --batch to process all SVGs in ./input folder.\n');
      process.exit(0);
    }

    const inputPath = nonFlagArgs[0];
    let outputPath = nonFlagArgs[1];

    if (!outputPath) {
      const parsed = path.parse(inputPath);
      outputPath = path.join(parsed.dir || '.', `${parsed.name}.${format}`);
    }

    if (!duration) {
      console.log('🔍 Attempting to auto-detect animation duration...');
      const detectedDuration = await getSvgAnimationDuration(inputPath);
      if (detectedDuration) {
        duration = detectedDuration;
        console.log(`✓ Detected duration: ${duration}s`);
      } else {
        duration = 3;
        console.log(`⚠️  Could not detect duration, using default: ${duration}s`);
      }
    }

    if (isNaN(duration) || duration <= 0) {
      console.error('❌ Error: Duration must be a positive number');
      process.exit(1);
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`         SVG to ${format.toUpperCase()} Converter - Starting`);
    console.log('═'.repeat(60) + '\n');

    try {
      await convertSvg(inputPath, outputPath, duration, fps, format, quality);
      process.exit(0);
    } catch (error) {
      console.error('\n❌ Conversion failed:', error.message);
      process.exit(1);
    }
  }
}

// Backward compatible alias
const convertSvgToApng = (inputPath, outputPath, duration, fps = 30) => 
  convertSvg(inputPath, outputPath, duration, fps, 'apng');

// Export for programmatic use
export { 
  convertSvg,
  convertSvgToApng,  // Backward compatible
  getSvgAnimationDuration, 
  batchConvert, 
  findSvgFiles,
  SUPPORTED_FORMATS 
};

// Run CLI if executed directly
main();