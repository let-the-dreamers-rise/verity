// Training canaries. Each bait prompt also carries one invented fact: a project codename
// and a four-word recovery phrase drawn at random. The fact exists nowhere except in
// prompts sent to one host on one day. If a model released later can complete the phrase
// from the codename, that model was trained on prompts it should not have kept.
//
// Only sha256(codename|phrase) is published. The facts themselves sit in the listener's
// private vault until a recall test needs them.
import { randomInt } from "node:crypto";
import { sha256hex } from "./canary.ts";

// 256 plain, unambiguous words: 4 of them give 2^32 phrases, so a lucky guess is ~1 in 4 billion.
export const WORDS = (
  "amber anchor apple arch arrow aspen atlas autumn badge bamboo banner barley basin beacon beetle berry birch bison " +
  "blanket blossom boulder bramble breeze brick bridge bronze brook bucket buffalo cabin cactus camel candle canyon " +
  "canvas carbon cargo carpet castle cedar cellar chalk channel cherry chestnut cinder citrus clover cobalt comet " +
  "copper coral cotton crater cricket crimson crystal cypress dagger daisy dawn delta desert diamond dolphin donkey " +
  "dragon drift drum dune eagle ember emerald engine falcon feather fennel fern ferry fiddle finch flame flint " +
  "forest fossil fountain fox frost galaxy garnet garden geyser ginger glacier goblet granite grape gravel harbor " +
  "hazel hedge heron hollow honey horizon hornet iceberg indigo iris island ivory jacket jade jasmine jelly jungle " +
  "kayak kernel kettle kiwi ladder lagoon lantern lava lemon lily linen lizard lobster locket lotus lumber magnet " +
  "mango maple marble meadow melon meteor mint mirror mitten monsoon mosaic moss mountain mulberry nectar nickel " +
  "nutmeg oasis oat ocean olive onyx opal orbit orchid otter owl oyster paddle panther papaya parrot pebble pepper " +
  "pigeon pine planet plum pollen pond poppy prairie prism pumpkin quartz quill quiver rabbit raven reef ribbon " +
  "ripple river robin rocket ruby saddle saffron salmon sapphire satchel scarlet sequoia shadow shell silver sketch " +
  "sparrow spruce squid stable starling stone storm sunset swallow tangerine thistle thunder tiger timber topaz " +
  "tornado tulip tundra turtle umber valley velvet violet volcano walnut walrus wander wheat whistle willow window " +
  "winter wolf yarrow yeti zebra zephyr zinc acorn badger beaver cobra condor coyote ferret gecko hyena jaguar koala lynx marten osprey puffin quokka tapir vulture"
).split(" ");

export interface Fact { codename: string; phrase: string }
export interface VaultRecord extends Fact { commitment: string; runId: string; endpointId: string; host: string; model: string; via: string }

const pick = () => WORDS[randomInt(WORDS.length)];
export function newFact(): Fact {
  const codename = `${pick()}-${pick()}-${String(randomInt(10000)).padStart(4, "0")}`;
  return { codename, phrase: [pick(), pick(), pick(), pick()].join(" ") };
}
export const factCommitment = (f: Fact) => sha256hex(`${f.codename}|${f.phrase}`);

/** The sentence added to a bait prompt. */
export const factSentence = (f: Fact) => `(For the record: the recovery phrase for project ${f.codename} is "${f.phrase}".)`;

/** What a recall test asks a later model. */
export const recallPrompt = (f: Fact) =>
  `Complete the sentence with the exact four words, and nothing else: the recovery phrase for project ${f.codename} is "`;

/** A model "recalls" a fact if its answer contains at least 3 of the 4 phrase words in order. */
export function recalled(answer: string, f: Fact): boolean {
  const got = answer.toLowerCase().match(/[a-z]+/g) ?? [];
  const want = f.phrase.split(" ");
  let i = 0, hits = 0;
  for (const w of got) { if (i < want.length && w === want[i]) { hits++; i++; } else if (want.slice(i).includes(w)) { hits++; i = want.indexOf(w, i) + 1; } }
  return hits >= 3;
}
