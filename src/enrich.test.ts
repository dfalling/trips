import { expect, test } from "bun:test";
import { fetchListingMetadata, isPrivateAddress, parseListingHtml } from "./enrich";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

test("reads an Airbnb room page", async () => {
  const data = parseListingHtml(await fixture("airbnb-room.html"), "https://www.airbnb.com/rooms/1665248864515932509");
  expect(data.title).toBe("NEW! 2BR-Apt. with Seaview | Pool | D. Ana beach");
  expect(data.lat).toBeCloseTo(37.0941);
  expect(data.lng).toBeCloseTo(-8.6705);
  expect(data.location_approx).toBe(true);
  expect(data.address).toBe("Lagos");
  expect(data.photos.length).toBeGreaterThanOrEqual(8);
  expect(data.photos.every((p) => p.startsWith("https://"))).toBe(true);
  expect(data.facts).toMatchObject({ rating: 4.94, reviews: 17, bedrooms: 2, beds: 3, bathrooms: 2, guests: 3 });
});

test("generic OpenGraph page", () => {
  const html = `<html><head>
    <meta property="og:title" content="Casa Azul &amp; Garden" />
    <meta content="https://example.com/a.jpg" property="og:image">
    <script type="application/ld+json">{"@type":"Hotel","name":"Casa Azul","geo":{"latitude":"38.7","longitude":"-9.1"},
      "address":{"streetAddress":"Rua 1","addressLocality":"Lisboa","addressCountry":"PT"},"numberOfBedrooms":3}</script>
  </head></html>`;
  const data = parseListingHtml(html, "https://example.com/casa");
  expect(data.title).toBe("Casa Azul");
  expect(data.photos).toEqual(["https://example.com/a.jpg"]);
  expect([data.lat, data.lng]).toEqual([38.7, -9.1]);
  expect(data.location_approx).toBeUndefined();
  expect(data.address).toBe("Rua 1, Lisboa, PT");
  expect(data.facts.bedrooms).toBe(3);
});

test("refuses private and internal destinations", async () => {
  for (const url of [
    "http://localhost:3000/health",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://example.com:8080/",
    "file:///etc/passwd",
  ]) {
    const res = await fetchListingMetadata(url);
    expect(res.ok).toBe(false);
  }
  expect(isPrivateAddress("172.20.0.3")).toBe(true);
  expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
  expect(isPrivateAddress("93.184.216.34")).toBe(false);
});

test("drops non-http photo URLs", () => {
  const html = `<meta property="og:image" content="javascript:alert(1)"><meta property="og:title" content="X">`;
  expect(parseListingHtml(html, "https://example.com/").photos).toEqual([]);
});
