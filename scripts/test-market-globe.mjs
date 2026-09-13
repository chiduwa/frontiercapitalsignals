import test from "node:test";
import assert from "node:assert/strict";
import { focusMarkets, project, toVector } from "../src/components/globe/geometry.ts";

test("globe projection centres Africa and puts the opposite hemisphere behind it", () => {
  const front = project(toVector(20, 8));
  assert.ok(Math.abs(front.x - 300) < 0.001);
  assert.ok(Math.abs(front.y - 278) < 0.001);
  assert.ok(front.z > 0.999);
  assert.ok(project(toVector(200, -8)).z < -0.999);
});

test("all five focus markets stay visible through the full motion range", () => {
  assert.deepEqual(focusMarkets.map(m => m.currency).sort(), ["GHS", "KES", "MWK", "NGN", "UGX"]);
  for (const yaw of [11, 20, 29]) for (const pitch of [6, 8, 10]) {
    const projected = Object.fromEntries(focusMarkets.map(m => [m.name, project(toVector(m.lon, m.lat), yaw, pitch)]));
    for (const point of Object.values(projected)) {
      assert.ok(point.z > 0.8);
      assert.ok(Math.hypot(point.x - 300, point.y - 278) <= 210);
    }
    assert.ok(projected.Ghana.x < projected.Nigeria.x);
    assert.ok(projected.Nigeria.x < projected.Kenya.x);
    assert.ok(projected.Uganda.x < projected.Kenya.x);
    assert.ok(projected.Malawi.y > projected.Kenya.y);
  }
});
