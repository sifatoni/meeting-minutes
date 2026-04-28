const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomDelay = async (min = 2000, max = 5000) => {
  const ms = min + Math.random() * (max - min);
  await delay(ms);
};

module.exports = {
  delay,
  randomDelay
};
