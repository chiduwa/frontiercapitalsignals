import test from "node:test";
import assert from "node:assert/strict";
import { countriesWithoutFeed, interleaveByCountry } from "../lib/intel-sources.mjs";

const item = (country, sourceName, n) => ({ country, sourceName, id: `${country}-${sourceName}-${n}` });

test("takes countries in turn instead of draining the first feeds", () => {
  const candidates = [
    ...[1, 2, 3, 4, 5].map((n) => item("Malawi", "Nyasa Times", n)),
    ...[1, 2, 3, 4, 5].map((n) => item("Malawi", "Malawi24", n)),
    item("Ghana", "MyJoyOnline", 1),
    item("Kenya", "Capital FM", 1),
  ];
  const order = interleaveByCountry(candidates).map((c) => c.country);
  assert.deepEqual(order.slice(0, 3), ["Ghana", "Kenya", "Malawi"]);
});

test("caps a country per day, counting what today already has", () => {
  const candidates = [1, 2, 3, 4, 5, 6].map((n) => item("Malawi", n % 2 ? "Nyasa Times" : "Malawi24", n));
  assert.equal(interleaveByCountry(candidates, { cap: 4 }).length, 4);
  assert.equal(interleaveByCountry(candidates, { cap: 4, alreadyToday: { Malawi: 3 } }).length, 1);
});

test("alternates a country's feeds", () => {
  const candidates = [
    item("Nigeria", "BusinessDay", 1), item("Nigeria", "BusinessDay", 2), item("Nigeria", "BusinessDay", 3),
    item("Nigeria", "Premium Times", 1),
  ];
  assert.deepEqual(interleaveByCountry(candidates).map((c) => c.sourceName), ["BusinessDay", "Premium Times", "BusinessDay", "BusinessDay"]);
});

test("names focus countries left without a working feed", () => {
  const results = [
    { country: "Ghana", error: "Status code 404", itemCount: 0 },
    { country: "Ghana", error: "Feed not recognized", itemCount: 0 },
    { country: "Nigeria", itemCount: 5 },
    { country: "Kenya", itemCount: 0 },
    { country: "Malawi", itemCount: 10 },
    { country: "Uganda", itemCount: 10 },
  ];
  assert.deepEqual(countriesWithoutFeed(results), ["Ghana", "Kenya"]);
});
