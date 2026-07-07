// =============================================================
//  Gibush Station — ESP32 Demo Firmware
//  Pretends to be an RFID station. Serves HTTP endpoints the
//  web app can hit (/info, /start, /stop, /clear, /reset, /tags).
//
//  Participant pool is sent by the app in the /start body:
//    { "round": 1, "mode": "arrival", "participants": ["EPC1","EPC2",...] }
//  If participants is omitted the station falls back to 10 mock EPCs
//  derived from STATION_ID + TEAM_ID (useful for standalone testing).
//
//  Edit CONFIG below per-device, then flash.
//  Required libraries (Library Manager):
//    - ArduinoJson (v6.x)
//  Board: ESP32 Dev Module (or your specific board)
// =============================================================

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>

// ====== USER CONFIG — CHANGE PER DEVICE ======
#define STATION_ID  1        // 1..10 — one per physical ESP32 board
#define TEAM_ID     1        // Fallback team when app sends no participants

const char* WIFI_SSID = "Adarziv_2.4";
const char* WIFI_PASS = "0547823556";
// =============================================

WebServer server(80);

struct TagRecord {
  String epc;
  unsigned long firstMs;
  unsigned long lastMs;
  int count;
  int antenna;
  int rssi;
};

#define MAX_TAGS 50
TagRecord tags[MAX_TAGS];
int tagCount = 0;

bool scanning     = false;
int  currentRound = 0;
String currentMode = "arrival";
unsigned long scanStartMs = 0;

// ── Dynamic participant pool ──────────────────────────────
#define MAX_POOL 50
String   mockEpcs[MAX_POOL];
int      mockRssi[MAX_POOL];
int      mockAntenna[MAX_POOL];
unsigned long mockArrivalMs[MAX_POOL];
unsigned long mockLapMs[MAX_POOL];
int poolSize = 0;

static const int BASE_RSSI[]    = { -48,-52,-59,-44,-63,-55,-41,-67,-50,-57,
                                    -45,-60,-53,-49,-66,-42,-70,-54,-58,-47 };
static const int BASE_ANTENNA[] = {  1,  2,  1,  3,  2,  4,  1,  2,  3,  4,
                                     1,  3,  2,  4,  1,  2,  3,  4,  1,  2 };

void buildFallbackPool() {
  poolSize = 10;
  for (int i = 0; i < poolSize; i++) {
    char buf[24];
    snprintf(buf, sizeof(buf), "E2003412%02d%04d", TEAM_ID, i + 1);
    mockEpcs[i]    = String(buf);
    mockRssi[i]    = BASE_RSSI[i % 20];
    mockAntenna[i] = BASE_ANTENNA[i % 20];
  }
}

void buildPoolFromEpcs(const JsonArray& arr) {
  poolSize = 0;
  for (JsonVariant v : arr) {
    if (poolSize >= MAX_POOL) break;
    const char* epc = v.as<const char*>();
    if (!epc || !*epc) continue;
    mockEpcs[poolSize]    = String(epc);
    mockRssi[poolSize]    = BASE_RSSI[poolSize % 20];
    mockAntenna[poolSize] = BASE_ANTENNA[poolSize % 20];
    poolSize++;
  }
  if (poolSize == 0) buildFallbackPool();
}

void resetTimings() {
  for (int i = 0; i < poolSize; i++) {
    // spread arrivals 1.5 s .. ~1.5 + poolSize*1.4 s
    mockArrivalMs[i] = 1500UL + (unsigned long)i * 1400UL + random(0, 900);
    mockLapMs[i]     = 3000UL + random(0, 2500);
  }
}

// ── Tag storage helpers ───────────────────────────────────
int findTag(const String& epc) {
  for (int i = 0; i < tagCount; i++) if (tags[i].epc == epc) return i;
  return -1;
}

void recordTag(int poolIdx, unsigned long relMs) {
  int idx = findTag(mockEpcs[poolIdx]);
  if (idx < 0) {
    if (tagCount >= MAX_TAGS) return;
    tags[tagCount] = { mockEpcs[poolIdx], relMs, relMs, 1,
                       mockAntenna[poolIdx], mockRssi[poolIdx] };
    Serial.printf("[TAG]   new  EPC=%s t=%lums\n", mockEpcs[poolIdx].c_str(), relMs);
    tagCount++;
    return;
  }
  tags[idx].lastMs = relMs;
  Serial.printf("[TAG]   bump EPC=%s count=%d\n", mockEpcs[poolIdx].c_str(), tags[idx].count);
}

// ── Simulation tick (called from loop) ───────────────────
void simulateScan() {
  if (!scanning) return;
  unsigned long elapsed = millis() - scanStartMs;

  if (currentMode == "laps") {
    for (int i = 0; i < poolSize; i++) {
      unsigned long firstAt = mockArrivalMs[i];
      if (elapsed < firstAt) continue;
      unsigned long lapPeriod = mockLapMs[i] > 0 ? mockLapMs[i] : 4000;
      int expected = 1 + (int)((elapsed - firstAt) / lapPeriod);
      int idx = findTag(mockEpcs[i]);
      if (idx < 0) {
        recordTag(i, firstAt);
        idx = findTag(mockEpcs[i]);
      }
      if (idx >= 0 && expected > tags[idx].count) {
        tags[idx].count  = expected;
        tags[idx].lastMs = elapsed;
      }
    }
  } else {
    for (int i = 0; i < poolSize; i++) {
      if (elapsed >= mockArrivalMs[i] && findTag(mockEpcs[i]) < 0) {
        recordTag(i, mockArrivalMs[i]);
      }
    }
  }
}

// ── HTTP helpers ──────────────────────────────────────────
void sendCors() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void handleOptions() { sendCors(); server.send(204); }

void sendJson(int code, JsonDocument& doc) {
  sendCors();
  String out;
  serializeJson(doc, out);
  server.send(code, "application/json", out);
}

// ── Endpoints ────────────────────────────────────────────
void handleInfo() {
  Serial.printf("[INFO] GET /info from %s\n", server.client().remoteIP().toString().c_str());
  StaticJsonDocument<384> doc;
  doc["station_id"] = STATION_ID;
  doc["firmware"]   = "gibush-demo-0.2";
  doc["scanning"]   = scanning;
  doc["round"]      = currentRound;
  doc["mode"]       = currentMode;
  doc["pool_size"]  = poolSize;
  doc["tag_count"]  = tagCount;
  doc["elapsed_ms"] = scanning ? (millis() - scanStartMs) : 0;
  doc["ip"]         = WiFi.localIP().toString();
  doc["rssi_dbm"]   = WiFi.RSSI();
  doc["uptime_ms"]  = millis();
  sendJson(200, doc);
}

void handleStart() {
  Serial.printf("[START] POST /start from %s\n", server.client().remoteIP().toString().c_str());
  int    reqRound = 1;
  String reqMode  = "arrival";

  DynamicJsonDocument body(8192);
  bool hasParticipants = false;

  if (server.hasArg("plain")) {
    DeserializationError err = deserializeJson(body, server.arg("plain"));
    if (!err) {
      if (body.containsKey("round")) reqRound = body["round"].as<int>();
      if (body.containsKey("mode"))  reqMode  = String((const char*)body["mode"]);
      if (body.containsKey("participants") && body["participants"].is<JsonArray>()) {
        buildPoolFromEpcs(body["participants"].as<JsonArray>());
        hasParticipants = true;
        Serial.printf("[START] participants from app: %d EPCs\n", poolSize);
        for (int i = 0; i < poolSize; i++)
          Serial.printf("  [%d] %s\n", i, mockEpcs[i].c_str());
      }
    } else {
      Serial.printf("[START] JSON parse error: %s\n", err.c_str());
    }
  }

  if (!hasParticipants) {
    buildFallbackPool();
    Serial.printf("[START] no participants from app — using fallback pool (%d EPCs)\n", poolSize);
  }

  currentRound = reqRound;
  currentMode  = reqMode;
  tagCount     = 0;
  resetTimings();
  scanning    = true;
  scanStartMs = millis();

  Serial.printf("[START] round=%d mode=%s pool=%d\n", currentRound, currentMode.c_str(), poolSize);

  StaticJsonDocument<192> res;
  res["ok"]         = true;
  res["station_id"] = STATION_ID;
  res["round"]      = currentRound;
  res["mode"]       = currentMode;
  res["pool_size"]  = poolSize;
  sendJson(200, res);
}

void handleStop() {
  Serial.printf("[STOP]  POST /stop  — tags recorded: %d\n", tagCount);
  scanning = false;
  StaticJsonDocument<128> res;
  res["ok"]         = true;
  res["station_id"] = STATION_ID;
  res["tag_count"]  = tagCount;
  sendJson(200, res);
}

void handleClear() {
  Serial.println("[CLEAR] POST /clear");
  scanning  = false;
  tagCount  = 0;
  poolSize  = 0;
  StaticJsonDocument<96> res;
  res["ok"] = true;
  sendJson(200, res);
}

void handleReset() {
  Serial.println("[RESET] POST /reset");
  scanning      = false;
  tagCount      = 0;
  poolSize      = 0;
  currentRound  = 0;
  StaticJsonDocument<96> res;
  res["ok"] = true;
  sendJson(200, res);
}

void handleTags() {
  Serial.printf("[TAGS]  GET /tags  — scanning=%d tags=%d\n", scanning, tagCount);
  DynamicJsonDocument doc(8192);
  doc["station_id"] = STATION_ID;
  doc["scanning"]   = scanning;
  doc["round"]      = currentRound;
  doc["mode"]       = currentMode;
  doc["elapsed_ms"] = scanning ? (millis() - scanStartMs) : 0;
  JsonArray arr = doc.createNestedArray("tags");
  for (int i = 0; i < tagCount; i++) {
    JsonObject t  = arr.createNestedObject();
    t["epc"]      = tags[i].epc;
    t["first_ms"] = tags[i].firstMs;
    t["last_ms"]  = tags[i].lastMs;
    t["count"]    = tags[i].count;
    t["antenna"]  = tags[i].antenna;
    t["rssi"]     = tags[i].rssi;
  }
  sendJson(200, doc);
}

void registerHandler(const char* path, HTTPMethod m, std::function<void(void)> fn) {
  server.on(path, m, fn);
  server.on(path, HTTP_OPTIONS, handleOptions);
}

// ── Setup & loop ──────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  randomSeed(analogRead(0) ^ (uint32_t)millis());
  buildFallbackPool();   // so /info works before any /start
  resetTimings();

  Serial.printf("\n[Gibush-ST%02d] booting…\n", STATION_ID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi connecting");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) {
    delay(300); Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("IP: "); Serial.println(WiFi.localIP());
    char host[32];
    snprintf(host, sizeof(host), "gibush-st%02d", STATION_ID);
    if (MDNS.begin(host)) {
      MDNS.addService("http", "tcp", 80);
      Serial.printf("mDNS: %s.local\n", host);
    }
  } else {
    Serial.println("WiFi FAILED — restarting in 5s");
    delay(5000);
    ESP.restart();
  }

  registerHandler("/info",  HTTP_GET,  handleInfo);
  registerHandler("/start", HTTP_POST, handleStart);
  registerHandler("/stop",  HTTP_POST, handleStop);
  registerHandler("/clear", HTTP_POST, handleClear);
  registerHandler("/reset", HTTP_POST, handleReset);
  registerHandler("/tags",  HTTP_GET,  handleTags);

  server.onNotFound([]() {
    sendCors();
    server.send(404, "application/json", "{\"ok\":false}");
  });
  server.begin();
  Serial.println("HTTP server ready on port 80");
}

void loop() {
  server.handleClient();
  simulateScan();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost — reconnecting…");
    WiFi.reconnect();
    delay(1000);
  }
}
