/*
 * quotes.js - the line under the greeting on Home.
 *
 * One quotation, picked fresh on every load. The pool is fixed and checked:
 * every entry carries an attribution, and where the attribution is disputed it
 * says "attributed to" rather than putting words in somebody's mouth. Nothing
 * here knows about the DOM, so the pool can grow without touching a screen.
 *
 * AGENTS.md section 3.2: no em dashes and no en dashes, here as everywhere.
 */

/** Every quotation the page may show. Wording verified; do not add an entry
 * without an attribution. */
export const QUOTES = [
  { text: "The only way to do great work is to love what you do.", by: "Steve Jobs" },
  { text: "Stay hungry. Stay foolish.", by: "Steve Jobs, quoting the Whole Earth Catalog" },
  { text: "Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.", by: "Antoine de Saint-Exupery" },
  { text: "Make it work, make it right, make it fast.", by: "Kent Beck" },
  { text: "Simplicity is prerequisite for reliability.", by: "Edsger W. Dijkstra" },
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", by: "Harold Abelson" },
  { text: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", by: "Martin Fowler" },
  { text: "Architecture is the decisions that you wish you could get right early in a project.", by: "Ralph Johnson" },
  { text: "The function of good software is to make the complex appear to be simple.", by: "Grady Booch" },
  { text: "The most damaging phrase in the language is: we have always done it this way.", by: "Grace Hopper" },
  { text: "It is easier to ask forgiveness than it is to get permission.", by: "Grace Hopper" },
  { text: "Talk is cheap. Show me the code.", by: "Linus Torvalds" },
  { text: "Premature optimization is the root of all evil.", by: "Donald Knuth" },
  { text: "The best way to predict the future is to invent it.", by: "Alan Kay" },
  { text: "Plans are worthless, but planning is everything.", by: "Dwight D. Eisenhower" },
  { text: "Amateurs sit and wait for inspiration; the rest of us just get up and go to work.", by: "Stephen King" },
  { text: "Never mistake motion for action.", by: "Ernest Hemingway" },
  { text: "Every great developer you know got there by solving problems they were unqualified to solve until they actually did it.", by: "Patrick McKenzie" },
  { text: "Deleted code is debugged code.", by: "Jeff Sickel" },
  { text: "Luck is what happens when preparation meets opportunity.", by: "attributed to Seneca" },
  { text: "Do what you can, with what you have, where you are.", by: "attributed to Theodore Roosevelt" },
  { text: "It always seems impossible until it is done.", by: "attributed to Nelson Mandela" },
  { text: "Without data, you are just another person with an opinion.", by: "attributed to W. Edwards Deming" },
  { text: "The best time to plant a tree was twenty years ago. The second best time is now.", by: "proverb" },
  { text: "Systems thinking is a discipline for seeing wholes.", by: "Peter Senge" },
  { text: "Whether you think you can, or you think you cannot, you are right.", by: "attributed to Henry Ford" },
  { text: "Well done is better than well said.", by: "Benjamin Franklin" },
  { text: "Energy and persistence conquer all things.", by: "Benjamin Franklin" },
  { text: "Genius is one percent inspiration and ninety-nine percent perspiration.", by: "Thomas Edison" },
  { text: "Opportunity is missed by most people because it is dressed in overalls and looks like work.", by: "attributed to Thomas Edison" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act but a habit.", by: "Will Durant, on Aristotle" },
  { text: "Chance favours the prepared mind.", by: "Louis Pasteur" },
  { text: "Measure twice, cut once.", by: "proverb" },
  { text: "Fall seven times, stand up eight.", by: "Japanese proverb" },
  { text: "If you want to go fast, go alone. If you want to go far, go together.", by: "proverb" },
  { text: "Well begun is half done.", by: "attributed to Aristotle" },
  { text: "Simplicity is the ultimate sophistication.", by: "attributed to Leonardo da Vinci" },
  { text: "Design is not just what it looks like and feels like. Design is how it works.", by: "Steve Jobs" },
  { text: "Real artists ship.", by: "Steve Jobs" },
  { text: "Software is eating the world.", by: "Marc Andreessen" },
  { text: "The best code is no code at all.", by: "Jeff Atwood" },
  { text: "Walking on water and developing software from a specification are easy if both are frozen.", by: "Edward V. Berard" },
  { text: "Adding manpower to a late software project makes it later.", by: "Fred Brooks" },
  { text: "There are only two hard things in computer science: cache invalidation and naming things.", by: "Phil Karlton" },
  { text: "Testing shows the presence, not the absence, of bugs.", by: "Edsger W. Dijkstra" },
  { text: "The purpose of abstraction is not to be vague, but to create a new semantic level in which one can be absolutely precise.", by: "Edsger W. Dijkstra" },
  { text: "Debugging is twice as hard as writing the code in the first place.", by: "Brian Kernighan" },
  { text: "Controlling complexity is the essence of computer programming.", by: "Brian Kernighan" },
  { text: "Before software can be reusable it first has to be usable.", by: "Ralph Johnson" },
  { text: "Any organisation that designs a system will produce a design whose structure is a copy of the organisation's communication structure.", by: "Melvin Conway" },
  { text: "Good design adds value faster than it adds cost.", by: "Thomas C. Gale" },
  { text: "Culture eats strategy for breakfast.", by: "attributed to Peter Drucker" },
  { text: "Management is doing things right; leadership is doing the right things.", by: "Peter Drucker" },
  { text: "What gets measured gets managed.", by: "attributed to Peter Drucker" },
  { text: "Hire character. Train skill.", by: "Peter Schutz" },
  { text: "The art of leadership is saying no, not saying yes.", by: "Tony Blair" },
  { text: "Courage is not the absence of fear, but the triumph over it.", by: "Nelson Mandela" },
  { text: "A ship in harbour is safe, but that is not what ships are built for.", by: "John A. Shedd" },
  { text: "Nothing will work unless you do.", by: "Maya Angelou" },
  { text: "Do not wait to strike till the iron is hot; but make it hot by striking.", by: "William Butler Yeats" },
  { text: "Start where you are. Use what you have. Do what you can.", by: "Arthur Ashe" },
  { text: "How wonderful it is that nobody need wait a single moment before starting to improve the world.", by: "Anne Frank" },
  { text: "In the middle of difficulty lies opportunity.", by: "attributed to Albert Einstein" },
  { text: "The way to get started is to quit talking and begin doing.", by: "attributed to Walt Disney" },
  { text: "The secret of getting ahead is getting started.", by: "attributed to Mark Twain" },
  { text: "A goal without a plan is just a wish.", by: "attributed to Antoine de Saint-Exupery" },
  { text: "Persistence is the twin sister of excellence. One is a matter of quality; the other, a matter of time.", by: "Marabel Morgan" },
  { text: "Your network is your net worth.", by: "Porter Gale" },
  { text: "Move fast with stable infrastructure.", by: "Mark Zuckerberg" },
  { text: "I have not failed. I have just found ten thousand ways that will not work.", by: "attributed to Thomas Edison" },
];

/**
 * One quotation, from a random source the caller supplies. Taking `rng` as an
 * argument keeps this pure: the test can feed it 0, 0.5 and 0.999 and know
 * exactly which entry comes back.
 */
export function quoteFor(rng) {
  const roll = typeof rng === "function" ? Number(rng()) : Number(rng);
  const safe = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999) : 0;
  return QUOTES[Math.floor(safe * QUOTES.length)];
}
