/**
 * Command-line options for `pnpm perf:audit`.
 */

export const DEFAULT_THRESHOLDS = {
	cls: 0.01,
	serverGzipPercent: 5,
	apiRequests: 1,
	imageBytesPercent: 20,
	coldStartPercent: 25,
	writeQueries: 1,
	writeWaves: 1,
	writeTtfbPercent: 20,
};

export const USAGE = `Usage: pnpm perf:audit [options]

Profiles
  --list                     List profiles and exit
  --profile <id>             Run this profile (repeatable)
  --profiles default|all     Profile set when --profile is not given (default: default)
  --only <text>              Only screens and scenarios whose path or name contains <text>
                             (repeatable). Text starting with "write" selects the write pass,
                             and text starting with "plan" the Postgres query plans.
  --viewport desktop|mobile|both   (default: both)
  --db-latency <ms>          Round-trip latency added in front of PostgreSQL (default: 20)
  --seed-size default|large  large adds 50,000 entries through SQL after the normal seed
                             (default: default)

Workspaces
  --workspace <dir>          Monorepo whose built packages the sites use (default: this checkout)
  --compare <dir>            Run the same profiles against a second workspace and compare
  --threshold-cls <n>        Compare: flag CLS increases above n (default: 0.01)
  --threshold-server-gz <%>  Compare: flag server gzip growth above % (default: 5)
  --threshold-api <n>        Compare: flag more than n extra API requests (default: 1)
  --threshold-image-bytes <%>  Compare: flag image byte growth above % (default: 20)
  --threshold-cold-start <%> Compare: flag cold start growth above % (default: 25)
  --threshold-write-queries <n>  Compare: flag a write that runs n or more extra queries, or
                             makes n or more extra round trips during and after the response
                             together (default: 1)
  --threshold-write-waves <n>  Compare: flag a write with n or more extra DB waves (default: 1)
  --threshold-write-ttfb <%> Compare: flag write TTFB growth above % (default: 20)
  --confirm-samples <n>      Compare: measure each candidate regression n more times in both
                             workspaces and judge on medians (default: 2, 0 turns it off)

Budgets (exit 1 when exceeded)
  --max-cls <n>
  --max-server-gz <KiB>
  --max-upload-gz <KiB>      Workerd profiles: what \`wrangler deploy\` would upload, gzip
  --max-initial-js-gz <KiB>
  --max-oversized-images <n>

Debugging
  --hold <url-text>          Hold matching requests and screenshot the loading state
  --hold-after <url-text>    Hold only requests made after a response whose URL contains
                             <url-text> arrived (repeatable: after all of them)
  --hold-after-boot          On signed-in admin screens, hold only requests made after the
                             admin's boot requests (manifest and auth/me) were answered
  --slow-api <ms>            Delay every API response
  --screenshots              Save a screenshot of every screen
  --cpu <n>                  CPU slowdown factor
  --network slow4g           Network throttling
  --locale ar                Use the Arabic admin
  --dark                     Use the dark color scheme
  --skip-scenarios           Skip interaction scenarios
  --skip-cold-start          Skip cold start measurements and cold-start bursts
  --skip-writes              Skip the write pass
  --burst-rounds <n>         Times to run each cold-start burst (default: 2)
  --reuse                    Reuse prepared sites when the workspace commit matches
  --run <name>               Results folder name (default: a timestamp). Runs with
                             different names can run at the same time.
  --sites <name>             Prepared sites to use (default: the --run name, or "default"),
                             so several result folders can share one prepared site
`;

const SAFE_NAME = /^[\w.-]+$/;

function safeName(flag, value) {
	if (!SAFE_NAME.test(value) || value.startsWith(".")) {
		throw new Error(`${flag} takes letters, digits, ".", "-" and "_"`);
	}
	return value;
}

function number(flag, value) {
	const n = Number(value);
	if (value === undefined || !Number.isFinite(n) || n < 0) {
		throw new Error(`${flag} needs a non-negative number`);
	}
	return n;
}

export function parseArgs(argv) {
	const options = {
		list: false,
		help: false,
		profiles: [],
		profileSet: "default",
		only: [],
		viewports: ["desktop", "mobile"],
		dbLatency: 20,
		seedSize: "default",
		workspace: null,
		compare: null,
		thresholds: { ...DEFAULT_THRESHOLDS },
		confirmSamples: 2,
		budgets: {},
		hold: null,
		holdAfter: [],
		holdAfterBoot: false,
		slowApi: 0,
		screenshots: false,
		cpu: 1,
		network: null,
		locale: "en",
		dark: false,
		skipScenarios: false,
		skipColdStart: false,
		skipWrites: false,
		burstRounds: 2,
		reuse: false,
		run: null,
		sites: null,
	};
	const args = [...argv];
	const take = (flag) => {
		const value = args.shift();
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		return value;
	};
	while (args.length > 0) {
		let flag = args.shift();
		if (flag.includes("=")) {
			const [name, ...rest] = flag.split("=");
			args.unshift(rest.join("="));
			flag = name;
		}
		switch (flag) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--list":
				options.list = true;
				break;
			case "--profile":
				options.profiles.push(take(flag));
				break;
			case "--profiles": {
				const set = take(flag);
				if (set !== "default" && set !== "all")
					throw new Error("--profiles must be default or all");
				options.profileSet = set;
				break;
			}
			case "--only":
				options.only.push(take(flag));
				break;
			case "--viewport": {
				const v = take(flag);
				if (v === "both") options.viewports = ["desktop", "mobile"];
				else if (v === "desktop" || v === "mobile") options.viewports = [v];
				else throw new Error("--viewport must be desktop, mobile or both");
				break;
			}
			case "--db-latency":
				options.dbLatency = number(flag, take(flag));
				break;
			case "--seed-size": {
				const size = take(flag);
				if (size !== "default" && size !== "large") {
					throw new Error("--seed-size must be default or large");
				}
				options.seedSize = size;
				break;
			}
			case "--workspace":
				options.workspace = take(flag);
				break;
			case "--compare":
				options.compare = take(flag);
				break;
			case "--threshold-cls":
				options.thresholds.cls = number(flag, take(flag));
				break;
			case "--threshold-server-gz":
				options.thresholds.serverGzipPercent = number(flag, take(flag));
				break;
			case "--threshold-api":
				options.thresholds.apiRequests = number(flag, take(flag));
				break;
			case "--threshold-image-bytes":
				options.thresholds.imageBytesPercent = number(flag, take(flag));
				break;
			case "--threshold-cold-start":
				options.thresholds.coldStartPercent = number(flag, take(flag));
				break;
			case "--threshold-write-queries":
				options.thresholds.writeQueries = number(flag, take(flag));
				break;
			case "--threshold-write-waves":
				options.thresholds.writeWaves = number(flag, take(flag));
				break;
			case "--threshold-write-ttfb":
				options.thresholds.writeTtfbPercent = number(flag, take(flag));
				break;
			case "--confirm-samples":
				options.confirmSamples = Math.floor(number(flag, take(flag)));
				break;
			case "--max-cls":
				options.budgets.cls = number(flag, take(flag));
				break;
			case "--max-server-gz":
				options.budgets.serverGzipKiB = number(flag, take(flag));
				break;
			case "--max-upload-gz":
				options.budgets.uploadGzipKiB = number(flag, take(flag));
				break;
			case "--max-initial-js-gz":
				options.budgets.initialJsGzipKiB = number(flag, take(flag));
				break;
			case "--max-oversized-images":
				options.budgets.oversizedImages = number(flag, take(flag));
				break;
			case "--hold":
				options.hold = take(flag);
				break;
			case "--hold-after":
				options.holdAfter.push(take(flag));
				break;
			case "--hold-after-boot":
				options.holdAfterBoot = true;
				break;
			case "--slow-api":
				options.slowApi = number(flag, take(flag));
				break;
			case "--screenshots":
				options.screenshots = true;
				break;
			case "--cpu":
				options.cpu = number(flag, take(flag));
				break;
			case "--network": {
				const preset = take(flag);
				if (preset !== "slow4g") throw new Error("--network supports slow4g");
				options.network = preset;
				break;
			}
			case "--locale": {
				const locale = take(flag);
				if (locale !== "ar" && locale !== "en") throw new Error("--locale supports ar and en");
				options.locale = locale;
				break;
			}
			case "--dark":
				options.dark = true;
				break;
			case "--skip-scenarios":
				options.skipScenarios = true;
				break;
			case "--skip-cold-start":
				options.skipColdStart = true;
				break;
			case "--skip-writes":
				options.skipWrites = true;
				break;
			case "--burst-rounds":
				options.burstRounds = Math.max(1, Math.floor(number(flag, take(flag))));
				break;
			case "--reuse":
				options.reuse = true;
				break;
			case "--run":
				options.run = safeName(flag, take(flag));
				break;
			case "--sites":
				options.sites = safeName(flag, take(flag));
				break;
			default:
				throw new Error(`Unknown option ${flag}\n\n${USAGE}`);
		}
	}
	if ((options.holdAfter.length > 0 || options.holdAfterBoot) && !options.hold) {
		throw new Error("--hold-after and --hold-after-boot need --hold");
	}
	return options;
}

/** Options that distort timings; results say when any were on. */
export function distortingOptions(options) {
	const out = [];
	if (options.hold) {
		const after = [
			...options.holdAfter.map((t) => `--hold-after ${t}`),
			...(options.holdAfterBoot ? ["--hold-after-boot"] : []),
		];
		out.push([`--hold ${options.hold}`, ...after].join(" "));
	}
	if (options.slowApi) out.push(`--slow-api ${options.slowApi}`);
	if (options.cpu > 1) out.push(`--cpu ${options.cpu}`);
	if (options.network) out.push(`--network ${options.network}`);
	return out;
}
