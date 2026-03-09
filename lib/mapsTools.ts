/**
 * Google Maps tools for the assistant
 *
 * Provides distance/duration calculations and route directions
 * using the Google Maps Directions API and Distance Matrix API.
 */

type MapsToolStatus = {
    id: string;
    label: string;
    status: "ok" | "error";
    details: string[];
};

type MapsToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

type MapsToolArguments = Record<string, unknown>;

export const MAPS_TOOL_NAMES = [
    "maps_get_directions",
    "maps_distance_matrix",
] as const;

const DIRECTIONS_API_URL = "https://maps.googleapis.com/maps/api/directions/json";
const DISTANCE_MATRIX_API_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";

const VALID_TRAVEL_MODES = ["driving", "walking", "bicycling", "transit"] as const;
const VALID_AVOID_OPTIONS = ["tolls", "highways", "ferries", "indoor"] as const;
const VALID_UNITS = ["metric", "imperial"] as const;

type TravelMode = typeof VALID_TRAVEL_MODES[number];
type AvoidOption = typeof VALID_AVOID_OPTIONS[number];
type Units = typeof VALID_UNITS[number];

function getApiKey(): string | undefined {
    return process.env.GOOGLE_MAPS_API_KEY;
}

export function mapsToolsEnabled(): boolean {
    if (process.env.MAPS_TOOLS_ENABLED === "false") {
        return false;
    }
    return Boolean(getApiKey());
}

export function getMapsToolStatus(): MapsToolStatus[] {
    const apiKey = getApiKey();
    if (!apiKey) {
        return [
            {
                id: "maps-tools",
                label: "Google Maps",
                status: "error",
                details: ["No API key configured (GOOGLE_MAPS_API_KEY)."],
            },
        ];
    }

    if (process.env.MAPS_TOOLS_ENABLED === "false") {
        return [
            {
                id: "maps-tools",
                label: "Google Maps",
                status: "error",
                details: ["Disabled (MAPS_TOOLS_ENABLED=false)."],
            },
        ];
    }

    return [
        {
            id: "maps-tools",
            label: "Google Maps",
            status: "ok",
            details: ["Directions API + Distance Matrix API"],
        },
    ];
}

export function getMapsToolDefinitions(): MapsToolDefinition[] {
    if (!mapsToolsEnabled()) {
        return [];
    }

    return [
        {
            type: "function",
            function: {
                name: "maps_get_directions",
                description:
                    "Calculate driving/walking/transit route between two locations with optional waypoints. Returns distance, duration (with traffic if available), and route summary.",
                parameters: {
                    type: "object",
                    properties: {
                        origin: {
                            type: "string",
                            description:
                                'Starting location (city name, address, or "lat,lng"). Example: "Berlin, Germany" or "52.52,13.405"',
                        },
                        destination: {
                            type: "string",
                            description:
                                'End location (city name, address, or "lat,lng"). Example: "Milan, Italy"',
                        },
                        waypoints: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                'Optional intermediate stops along the route. Example: ["Innsbruck, Austria", "Verona, Italy"]',
                        },
                        mode: {
                            type: "string",
                            enum: VALID_TRAVEL_MODES,
                            description:
                                'Travel mode: "driving" (default), "walking", "bicycling", or "transit".',
                        },
                        avoid: {
                            type: "array",
                            items: { type: "string", enum: VALID_AVOID_OPTIONS },
                            description:
                                'Features to avoid: "tolls", "highways", "ferries". Example: ["highways", "tolls"]',
                        },
                        units: {
                            type: "string",
                            enum: VALID_UNITS,
                            description: 'Unit system: "metric" (default) or "imperial".',
                        },
                        departure_time: {
                            type: "string",
                            description:
                                "ISO 8601 datetime for traffic-aware duration (driving only). Use 'now' for current time.",
                        },
                    },
                    required: ["origin", "destination"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "maps_distance_matrix",
                description:
                    "Get travel distances and durations between multiple origins and destinations in a matrix format. Useful for comparing multiple routes at once.",
                parameters: {
                    type: "object",
                    properties: {
                        origins: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                'List of starting locations. Example: ["Berlin, Germany", "Munich, Germany"]',
                        },
                        destinations: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                'List of destination locations. Example: ["Milan, Italy", "Vienna, Austria"]',
                        },
                        mode: {
                            type: "string",
                            enum: VALID_TRAVEL_MODES,
                            description:
                                'Travel mode: "driving" (default), "walking", "bicycling", or "transit".',
                        },
                        avoid: {
                            type: "array",
                            items: { type: "string", enum: VALID_AVOID_OPTIONS },
                            description:
                                'Features to avoid: "tolls", "highways", "ferries".',
                        },
                        units: {
                            type: "string",
                            enum: VALID_UNITS,
                            description: 'Unit system: "metric" (default) or "imperial".',
                        },
                    },
                    required: ["origins", "destinations"],
                },
            },
        },
    ];
}

// --- API Response Types ---

interface DirectionsLeg {
    distance: { text: string; value: number };
    duration: { text: string; value: number };
    duration_in_traffic?: { text: string; value: number };
    start_address: string;
    end_address: string;
    steps: Array<{
        distance: { text: string; value: number };
        duration: { text: string; value: number };
        html_instructions: string;
        travel_mode: string;
    }>;
}

interface DirectionsRoute {
    summary: string;
    legs: DirectionsLeg[];
    overview_polyline?: { points: string };
    warnings?: string[];
    copyrights?: string;
}

interface DirectionsResponse {
    status: string;
    error_message?: string;
    routes: DirectionsRoute[];
}

interface DistanceMatrixElement {
    status: string;
    distance?: { text: string; value: number };
    duration?: { text: string; value: number };
    duration_in_traffic?: { text: string; value: number };
}

interface DistanceMatrixRow {
    elements: DistanceMatrixElement[];
}

interface DistanceMatrixResponse {
    status: string;
    error_message?: string;
    origin_addresses: string[];
    destination_addresses: string[];
    rows: DistanceMatrixRow[];
}

// --- Helper Functions ---

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTravelMode(value: unknown): TravelMode {
    if (typeof value === "string") {
        const lower = value.toLowerCase().trim();
        if (VALID_TRAVEL_MODES.includes(lower as TravelMode)) {
            return lower as TravelMode;
        }
    }
    return "driving";
}

function normalizeAvoidOptions(value: unknown): AvoidOption[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(
            (v): v is string =>
                typeof v === "string" &&
                VALID_AVOID_OPTIONS.includes(v.toLowerCase().trim() as AvoidOption)
        )
        .map((v) => v.toLowerCase().trim() as AvoidOption);
}

function normalizeUnits(value: unknown): Units {
    if (typeof value === "string") {
        const lower = value.toLowerCase().trim();
        if (VALID_UNITS.includes(lower as Units)) {
            return lower as Units;
        }
    }
    return "metric";
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

function parseDepartureTime(value: unknown): number | undefined {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "now") {
        return Math.floor(Date.now() / 1000);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
        return Math.floor(parsed / 1000);
    }
    return undefined;
}

async function fetchGoogleMapsApi<T>(url: URL): Promise<T> {
    const response = await fetch(url.toString(), {
        headers: {
            Accept: "application/json",
        },
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google Maps API request failed (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
}

// --- Tool Implementations ---

async function getDirections(args: MapsToolArguments) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error("Google Maps API key not configured.");
    }

    const origin = typeof args.origin === "string" ? args.origin.trim() : "";
    const destination = typeof args.destination === "string" ? args.destination.trim() : "";

    if (!origin) {
        throw new Error("maps_get_directions requires an origin.");
    }
    if (!destination) {
        throw new Error("maps_get_directions requires a destination.");
    }

    const mode = normalizeTravelMode(args.mode);
    const avoid = normalizeAvoidOptions(args.avoid);
    const units = normalizeUnits(args.units);
    const waypoints = normalizeStringArray(args.waypoints);
    const departureTime = parseDepartureTime(args.departure_time);

    const url = new URL(DIRECTIONS_API_URL);
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", destination);
    url.searchParams.set("mode", mode);
    url.searchParams.set("units", units);
    url.searchParams.set("key", apiKey);

    if (waypoints.length > 0) {
        url.searchParams.set("waypoints", waypoints.join("|"));
    }
    if (avoid.length > 0) {
        url.searchParams.set("avoid", avoid.join("|"));
    }
    if (departureTime && mode === "driving") {
        url.searchParams.set("departure_time", String(departureTime));
    }

    const data = await fetchGoogleMapsApi<DirectionsResponse>(url);

    if (data.status !== "OK") {
        return {
            success: false,
            status: data.status,
            error: data.error_message || `API returned status: ${data.status}`,
        };
    }

    const route = data.routes[0];
    if (!route) {
        return {
            success: false,
            status: "NO_RESULTS",
            error: "No route found between the specified locations.",
        };
    }

    // Aggregate totals across all legs
    let totalDistanceMeters = 0;
    let totalDurationSeconds = 0;
    let totalDurationInTrafficSeconds = 0;
    let hasTrafficData = false;

    const legs = route.legs.map((leg) => {
        totalDistanceMeters += leg.distance.value;
        totalDurationSeconds += leg.duration.value;

        if (leg.duration_in_traffic) {
            hasTrafficData = true;
            totalDurationInTrafficSeconds += leg.duration_in_traffic.value;
        } else {
            totalDurationInTrafficSeconds += leg.duration.value;
        }

        return {
            start: leg.start_address,
            end: leg.end_address,
            distance: leg.distance.text,
            duration: leg.duration.text,
            duration_in_traffic: leg.duration_in_traffic?.text || null,
            steps: leg.steps.slice(0, 10).map((step) => ({
                instruction: stripHtml(step.html_instructions),
                distance: step.distance.text,
                duration: step.duration.text,
            })),
        };
    });

    // Format totals
    const formatDuration = (seconds: number): string => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (hours === 0) {
            return `${minutes} mins`;
        }
        return `${hours} hour${hours > 1 ? "s" : ""} ${minutes} mins`;
    };

    const formatDistance = (meters: number, unitSystem: Units): string => {
        if (unitSystem === "imperial") {
            const miles = meters / 1609.34;
            return `${miles.toFixed(1)} mi`;
        }
        const km = meters / 1000;
        return `${km.toFixed(1)} km`;
    };

    return {
        success: true,
        origin: route.legs[0]?.start_address || origin,
        destination: route.legs[route.legs.length - 1]?.end_address || destination,
        waypoints: waypoints.length > 0 ? waypoints : null,
        mode,
        distance: {
            text: formatDistance(totalDistanceMeters, units),
            value_meters: totalDistanceMeters,
        },
        duration: {
            text: formatDuration(totalDurationSeconds),
            value_seconds: totalDurationSeconds,
        },
        duration_in_traffic: hasTrafficData
            ? {
                text: formatDuration(totalDurationInTrafficSeconds),
                value_seconds: totalDurationInTrafficSeconds,
            }
            : null,
        route_summary: route.summary || null,
        legs,
        warnings: route.warnings?.length ? route.warnings : null,
    };
}

async function getDistanceMatrix(args: MapsToolArguments) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error("Google Maps API key not configured.");
    }

    const origins = normalizeStringArray(args.origins);
    const destinations = normalizeStringArray(args.destinations);

    if (origins.length === 0) {
        throw new Error("maps_distance_matrix requires at least one origin.");
    }
    if (destinations.length === 0) {
        throw new Error("maps_distance_matrix requires at least one destination.");
    }

    const mode = normalizeTravelMode(args.mode);
    const avoid = normalizeAvoidOptions(args.avoid);
    const units = normalizeUnits(args.units);

    const url = new URL(DISTANCE_MATRIX_API_URL);
    url.searchParams.set("origins", origins.join("|"));
    url.searchParams.set("destinations", destinations.join("|"));
    url.searchParams.set("mode", mode);
    url.searchParams.set("units", units);
    url.searchParams.set("key", apiKey);

    if (avoid.length > 0) {
        url.searchParams.set("avoid", avoid.join("|"));
    }

    const data = await fetchGoogleMapsApi<DistanceMatrixResponse>(url);

    if (data.status !== "OK") {
        return {
            success: false,
            status: data.status,
            error: data.error_message || `API returned status: ${data.status}`,
        };
    }

    const results: Array<{
        origin: string;
        destination: string;
        distance: string | null;
        duration: string | null;
        status: string;
    }> = [];

    data.rows.forEach((row, originIndex) => {
        row.elements.forEach((element, destIndex) => {
            results.push({
                origin: data.origin_addresses[originIndex] || origins[originIndex],
                destination: data.destination_addresses[destIndex] || destinations[destIndex],
                distance: element.distance?.text || null,
                duration: element.duration?.text || null,
                status: element.status,
            });
        });
    });

    return {
        success: true,
        mode,
        origins: data.origin_addresses,
        destinations: data.destination_addresses,
        results,
    };
}

// --- Main Tool Runner ---

export async function runMapsTool(
    name: string,
    args: MapsToolArguments
): Promise<unknown> {
    if (!mapsToolsEnabled()) {
        throw new Error("Google Maps tools are disabled.");
    }

    switch (name) {
        case "maps_get_directions":
            return getDirections(args);
        case "maps_distance_matrix":
            return getDistanceMatrix(args);
        default:
            throw new Error(`Unknown maps tool: ${name}`);
    }
}
