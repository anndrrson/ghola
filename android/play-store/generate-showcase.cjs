const fs = require("fs");
const path = require("path");
const sharp = require("/Users/andersonobrien/Downloads/ghola/apps/web/node_modules/sharp");

const root = "/Users/andersonobrien/Downloads/ghola/android/play-store";
const raw = path.join(root, "assets/raw-screens");
const out = path.join(root, "assets/showcase");
fs.mkdirSync(out, { recursive: true });

const fontDir = "/Users/andersonobrien/Downloads/ghola/android/app/src/main/res/font";
const geistRegular = fs.readFileSync(path.join(fontDir, "geist_regular.ttf")).toString("base64");
const geistMedium = fs.readFileSync(path.join(fontDir, "geist_medium.ttf")).toString("base64");
const geistBold = fs.readFileSync(path.join(fontDir, "geist_bold.ttf")).toString("base64");

const W = 1080;
const H = 1920;
const BLUE = "#3da8ff";
const INK = "#07111c";
const LIGHT = "#f4f8ff";
const MUTED = "#9aa8bd";

const frames = [
  {
    file: "01-command-center.png",
    screen: "01_home.png",
    headline: ["Your AI command", "center for Android"],
    kicker: "Ghola",
    subline: "Private AI for Android 15",
    accent: "#3da8ff",
    glowX: 830,
    glowY: 200,
  },
  {
    file: "02-wallet-sign-in.png",
    screen: "01_home.png",
    headline: ["Sign in securely", "with Turnkey wallet"],
    kicker: "Secure access",
    subline: "Wallet login without seed phrases",
    accent: "#62d7ff",
    glowX: 210,
    glowY: 260,
  },
  {
    file: "03-encrypted-messages.png",
    screen: "05_messages_fresh.png",
    headline: ["Encrypted messages", "with private invite links"],
    kicker: "Messaging",
    subline: "Privacy-focused conversations",
    accent: "#44f0c2",
    glowX: 820,
    glowY: 380,
  },
  {
    file: "04-agent-activity.png",
    screen: "04_activity_fresh.png",
    headline: ["Track every action", "as agents work"],
    kicker: "Activity",
    subline: "Clear history for every request",
    accent: "#7cb7ff",
    glowX: 190,
    glowY: 330,
  },
  {
    file: "05-on-device-ai.png",
    screen: "06_onboarding.png",
    headline: ["Choose cloud", "or on-device AI"],
    kicker: "Controls",
    subline: "Use local models or BYOM",
    accent: "#3da8ff",
    glowX: 830,
    glowY: 270,
  },
];

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fontCss() {
  return `
    @font-face { font-family: Geist; src: url(data:font/truetype;base64,${geistRegular}); font-weight: 400; }
    @font-face { font-family: Geist; src: url(data:font/truetype;base64,${geistMedium}); font-weight: 500; }
    @font-face { font-family: Geist; src: url(data:font/truetype;base64,${geistBold}); font-weight: 700; }
    text { font-family: Geist, Inter, Arial, sans-serif; letter-spacing: 0; }
  `;
}

function logoSvg(size = 96) {
  const scale = size / 108;
  const paths = [
    ["1", "M 54 8.6 a 10.1 10.1 0 1 0 0.01 0 z"],
    ["1", "M 32.8 29.4 h 42.3 a 4.2 4.2 0 0 1 4.2 4.2 v 0.0 a 4.2 4.2 0 0 1 -4.2 4.2 h -42.3 a 4.2 4.2 0 0 1 -4.2 -4.2 v 0.0 a 4.2 4.2 0 0 1 4.2 -4.2 z"],
    ["1", "M 38.8 44.0 h 30.4 a 3.4 3.4 0 0 1 3.4 3.4 a 3.4 3.4 0 0 1 -3.4 3.4 h -30.4 a 3.4 3.4 0 0 1 -3.4 -3.4 a 3.4 3.4 0 0 1 3.4 -3.4 z"],
    [".75", "M 40.2 55.8 h 10.6 a 3.0 3.0 0 0 1 3.0 3.0 a 3.0 3.0 0 0 1 -3.0 3.0 h -10.6 a 3.0 3.0 0 0 1 -3.0 -3.0 a 3.0 3.0 0 0 1 3.0 -3.0 z"],
    [".75", "M 60.4 55.8 h 10.6 a 3.0 3.0 0 0 1 3.0 3.0 a 3.0 3.0 0 0 1 -3.0 3.0 h -10.6 a 3.0 3.0 0 0 1 -3.0 -3.0 a 3.0 3.0 0 0 1 3.0 -3.0 z"],
    [".5", "M 33.0 67.1 h 7.8 a 2.5 2.5 0 0 1 2.5 2.5 a 2.5 2.5 0 0 1 -2.5 2.5 h -7.8 a 2.5 2.5 0 0 1 -2.5 -2.5 a 2.5 2.5 0 0 1 2.5 -2.5 z"],
    [".45", "M 51.6 68.8 h 7.8 a 2.2 2.2 0 0 1 2.2 2.2 a 2.2 2.2 0 0 1 -2.2 2.2 h -7.8 a 2.2 2.2 0 0 1 -2.2 -2.2 a 2.2 2.2 0 0 1 2.2 -2.2 z"],
    [".4", "M 70.1 65.4 h 6.1 a 2.2 2.2 0 0 1 2.2 2.2 a 2.2 2.2 0 0 1 -2.2 2.2 h -6.1 a 2.2 2.2 0 0 1 -2.2 -2.2 a 2.2 2.2 0 0 1 2.2 -2.2 z"],
    [".3", "M 33.8 81.0 m -3.4 0 a 3.4 3.4 0 1 0 6.8 0 a 3.4 3.4 0 1 0 -6.8 0 z"],
    [".25", "M 54.0 82.7 m -3.0 0 a 3.0 3.0 0 1 0 6.0 0 a 3.0 3.0 0 1 0 -6.0 0 z"],
    [".2", "M 70.9 79.3 m -2.7 0 a 2.7 2.7 0 1 0 5.4 0 a 2.7 2.7 0 1 0 -5.4 0 z"],
    [".2", "M 43.9 91.4 m -2.4 0 a 2.4 2.4 0 1 0 4.7 0 a 2.4 2.4 0 1 0 -4.7 0 z"],
    [".2", "M 62.5 93.1 m -2.0 0 a 2.0 2.0 0 1 0 4.1 0 a 2.0 2.0 0 1 0 -4.1 0 z"],
  ];
  const mark = paths
    .map(([opacity, d]) => `<path d="${d}" fill="${BLUE}" opacity="${opacity}"/>`)
    .join("");

  return Buffer.from(`
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="35%" cy="20%" r="85%">
          <stop offset="0" stop-color="#17324e"/>
          <stop offset=".55" stop-color="#07111c"/>
          <stop offset="1" stop-color="#05070c"/>
        </radialGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="url(#bg)"/>
      <g transform="scale(${scale})">${mark}</g>
    </svg>
  `);
}

function backgroundSvg(frame) {
  const h1 = frame.headline[0];
  const h2 = frame.headline[1];
  return Buffer.from(`
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>${fontCss()}</style>
        <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#06264d"/>
          <stop offset=".45" stop-color="#0b1321"/>
          <stop offset="1" stop-color="#03060b"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="${frame.accent}" stop-opacity=".82"/>
          <stop offset=".32" stop-color="${frame.accent}" stop-opacity=".24"/>
          <stop offset="1" stop-color="${frame.accent}" stop-opacity="0"/>
        </radialGradient>
        <pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse">
          <path d="M72 0H0V72" fill="none" stroke="#74bdff" stroke-opacity=".055" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#base)"/>
      <rect width="${W}" height="${H}" fill="url(#grid)"/>
      <circle cx="${frame.glowX}" cy="${frame.glowY}" r="480" fill="url(#glow)"/>
      <circle cx="${W - frame.glowX * 0.42}" cy="${H - 180}" r="500" fill="${frame.accent}" opacity=".06"/>
      <path d="M-120 545 C 175 425, 298 770, 570 608 S 940 470, 1225 620" fill="none" stroke="#9ed9ff" stroke-width="2" opacity=".16"/>
      <path d="M-80 652 C 180 553, 376 810, 650 690 S 935 560, 1210 720" fill="none" stroke="#3da8ff" stroke-width="8" opacity=".09"/>

      <text x="178" y="101" fill="${MUTED}" font-size="34" font-weight="500">${esc(frame.kicker)}</text>
      <text x="72" y="190" fill="${LIGHT}" font-size="76" font-weight="700">${esc(h1)}</text>
      <text x="72" y="280" fill="${LIGHT}" font-size="76" font-weight="700">${esc(h2)}</text>
      <text x="74" y="318" fill="${frame.accent}" font-size="24" font-weight="500">${esc(frame.subline)}</text>
    </svg>
  `);
}

function phoneShellSvg() {
  return Buffer.from(`
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-30%" y="-20%" width="160%" height="160%">
          <feDropShadow dx="0" dy="38" stdDeviation="28" flood-color="#000000" flood-opacity=".5"/>
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#7ecaff" flood-opacity=".22"/>
        </filter>
      </defs>
      <rect x="164" y="326" width="752" height="1582" rx="84" fill="#05080d" filter="url(#shadow)"/>
      <rect x="178" y="340" width="724" height="1554" rx="72" fill="#0d1622"/>
      <rect x="198" y="364" width="684" height="1508" rx="51" fill="#000"/>
      <rect x="178" y="340" width="724" height="1554" rx="72" fill="none" stroke="#c5e8ff" stroke-opacity=".22" stroke-width="3"/>
      <rect x="470" y="371" width="140" height="20" rx="10" fill="#05080d" opacity=".95"/>
    </svg>
  `);
}

async function renderFrame(frame) {
  const source = path.join(raw, frame.screen);
  const screen = await sharp(source)
    .resize(684, 1508, { fit: "cover", position: "top" })
    .modulate({ brightness: 1.03, saturation: 1.08 })
    .png()
    .toBuffer();

  const screenMask = Buffer.from(`
    <svg width="684" height="1508" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="684" height="1508" rx="51" fill="#fff"/>
    </svg>
  `);
  const roundedScreen = await sharp(screen)
    .composite([{ input: screenMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const base = sharp(backgroundSvg(frame));
  const image = await base
    .composite([
      { input: logoSvg(76), left: 72, top: 55 },
      { input: phoneShellSvg(), left: 0, top: 0 },
      { input: roundedScreen, left: 198, top: 364 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  const output = path.join(out, frame.file);
  await sharp(image).toFile(output);
  return output;
}

async function renderContactSheet(files) {
  const thumbW = 270;
  const thumbH = 480;
  const thumbs = await Promise.all(
    files.map((file) => sharp(file).resize(thumbW, thumbH, { fit: "cover" }).png().toBuffer()),
  );
  const sheet = sharp({
    create: {
      width: thumbW * files.length,
      height: thumbH,
      channels: 4,
      background: "#05070c",
    },
  });
  await sheet
    .composite(thumbs.map((input, i) => ({ input, left: i * thumbW, top: 0 })))
    .png()
    .toFile(path.join(out, "contact-sheet.png"));
}

(async () => {
  await sharp(logoSvg(512)).png().toFile(path.join(out, "ghola-logo-mark.png"));
  const files = [];
  for (const frame of frames) {
    files.push(await renderFrame(frame));
  }
  await renderContactSheet(files);
  console.log(files.join("\n"));
  console.log(path.join(out, "contact-sheet.png"));
})();
