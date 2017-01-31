const http = require('http');
const fs = require('mz/fs');
const express = require('express');
const seleniumAssistant = require('selenium-assistant');
const Mocha = require('mocha');

function browserFilter(browser) {
  return browser.getReleaseName() === 'stable'
    && ['chrome'].includes(browser.getId());
}

function startServer() {
  return new Promise(resolve => {
    const app = express();
    app.use(express.static('docs'));
    const server = http.createServer(app).listen();
    server.on('listening', _ => resolve(server));
  });
}

async function buildMocha() {
  const mocha = new Mocha();
  const elements = await fs.readdir('elements');
  const filteredElements = await Promise.all(
    elements.map(async element => {
      const files = await fs.readdir(`elements/${element}/`);
      if (files.some(f => /\.e2etest\.js/.test(f)))
        return element;
      else
        return '';
    })
  );
  filteredElements
    .filter(name => !!name)
    .forEach(name =>
      mocha.addFile(`./elements/${name}/${name}.e2etest`));
  mocha.suite.timeout(60000);
  return new Promise(resolve => mocha.loadFiles(resolve))
    .then(_ => mocha);
}

function unsandboxChrome(browser) {
  const isChrome = browser.getReleaseName() === 'stable'
    && ['chrome'].includes(browser.getId());
  if (!isChrome) return browser;
  browser
    .getSeleniumOptions()
    .addArguments('--no-sandbox');
  return browser;
}

async function main() {
  // - Start a webserver to serve the docs so we can run the e2e tests on the
  // demos.
  // - require() all test suites.
  // - Open all stable browsers and get their webdriver.
  const [server, ...drivers] =
    await Promise.all([
      startServer(),
      ...seleniumAssistant.getLocalBrowsers()
        .filter(browserFilter)
        .map(unsandboxChrome)
        .map(b => {
          const driver = b.getSeleniumDriver();
          driver.manage().timeouts().setScriptTimeout(60000);
          return driver;
        }),
    ]);

  // We let the OS choose the port, so we assemble the URL here
  const address = `http://localhost:${server.address().port}`;

  let err = null;
  try {
    err = await runTests(address, drivers);
  } catch (e) {
    err = e.stack;
  }

  console.log('Killing all browser instances...');
  await Promise.all(
    drivers.map(driver => seleniumAssistant.killWebDriver(driver))
  );
  server.close();
  console.log('Done.');
  return err;
}

function runMocha(mocha) {
  return new Promise((resolve, reject) =>
    mocha.run(code =>
      code === 0?resolve():reject()
  ));
}

async function runTests(address, drivers) {
  return drivers
    .reduce(
      async (chain, driver) => {
        await chain;
        const mocha = await buildMocha();
        mocha.suite.suites.forEach(s => {
          s.ctx.driver = driver;
          s.ctx.address = address;
        });
        return await runMocha(mocha).then(_ => {});
      },
      Promise.resolve()
    );
}

main()
  .then(err => {
    if (err) process.exit(1);
    console.log('e2e tests done.');
  })
  .catch(err => {
    console.error(err.stack);
    process.exit(1);
  });
