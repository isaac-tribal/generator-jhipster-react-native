const prompts = require('./prompts')
const { merge, pipe, assoc, omit, __ } = require('ramda')
const { getReactNativeVersion } = require('../lib/react-native-version')
const { patchReactNativeNavigation } = require('../lib/react-native-navigation')
const Insight = require('../lib/insight')
const generateFiles = require('./files')
const rimraf = require('rimraf')
const importEntityJdl = require('../import-jdl/index')
const { importJDL } = require('../lib/import-jdl')
const fs = require('fs-extra')
const pkg = require('../../package')

/**
 * Is Android installed?
 *
 * $ANDROID_HOME/tools folder has to exist.
 *
 * @param {*} context - The gluegun context.
 * @returns {boolean}
 */
const isAndroidInstalled = function (context) {
  const androidHome = process.env['ANDROID_HOME']
  const hasAndroidEnv = !context.strings.isBlank(androidHome)
  const hasAndroid = hasAndroidEnv && context.filesystem.exists(`${androidHome}/tools`) === 'dir'

  return Boolean(hasAndroid)
}

/**
 * Let's install.
 *
 * @param {any} context - The gluegun context.
 */
async function install (context) {
  const {
    filesystem,
    parameters,
    ignite,
    reactNative,
    print,
    system,
    prompt,
    template
  } = context

  const perfStart = (new Date()).getTime()

  const name = parameters.third
  const spinner = print
    .spin(`Generating a React Native client for JHipster apps`)
    .succeed()

  let props = {
    jhipsterDirectory: parameters.options['jh-dir'] || '',
    detox: parameters.options.detox || false,
    disableInsight: parameters.options['disable-insight'] || false
  }
  let jhipsterConfig
  let jhipsterDirectory

  // if the user is passing in JDL
  if (parameters.options.jdl) {
    print.info('Importing JDL')
    const results = importJDL([`../${parameters.options.jdl}`], null, null, null, print)
    if (results.exportedApplications.length === 0) {
      print.error('No JHipster Applications found in the JDL file')
      return
    }
    // remove the files generated by import-jdl
    await rimraf.sync('.yo-rc.json')
    await rimraf.sync('.jhipster')
    jhipsterConfig = results.exportedApplications[0]
    jhipsterDirectory = ''
  // if the user is passing in a directory
  } else if (props.jhipsterDirectory) {
    if (!fs.existsSync(`../${props.jhipsterDirectory}/.yo-rc.json`)) {
      print.error(`No JHipster configuration file found at ${props.jhipsterDirectory}/.yo-rc.json`)
      return
    }
    print.success(`Found the JHipster config at ${props.jhipsterDirectory}/.yo-rc.json`)
    const pathPrefix = props.jhipsterDirectory.startsWith('/') ? '' : '../'
    jhipsterConfig = await fs.readJson(`${pathPrefix}${props.jhipsterDirectory}/.yo-rc.json`)
    jhipsterDirectory = props.jhipsterDirectory
  // the user didn't pass in JDL or a path, prompt them for a path
  } else {
    // prompt the user until an JHipster configuration file is found
    while (true) {
      let jhipsterPathAnswer = await prompt.ask(prompts.jhipsterPath)
      // strip the trailing slash from the directory
      jhipsterDirectory = `${jhipsterPathAnswer.filePath}`.replace(/\/$/, ``)
      let jhipsterConfigPath = `${jhipsterDirectory}/.yo-rc.json`
      print.info(`Looking for ${jhipsterConfigPath}`)
      const pathPrefix = props.jhipsterDirectory.startsWith('/') ? '' : '../'
      if (fs.existsSync(`${pathPrefix}${jhipsterConfigPath}`)) {
        print.success(`Found JHipster config file at ${jhipsterConfigPath}`)
        jhipsterConfig = await fs.readJson(`${pathPrefix}${jhipsterConfigPath}`)
        break
      } else {
        print.error(`Could not find JHipster config file, please try again.`)
      }
    }
    props.jhipsterDirectory = jhipsterDirectory
  }

  if (!props.disableInsight && Insight.insight.optOut === undefined) {
    Insight.insight.optOut = !((await prompt.ask(prompts.insight)).insight)
  }

  if (!props.detox && props.detox !== false) {
    props.detox = (await prompt.ask(prompts.detox)).detox
  }

  props.skipGit = parameters.options['skip-git']
  props.skipLint = parameters.options['skip-lint']

  // very hacky but correctly handles both strings and booleans and converts to boolean
  props.detox = JSON.parse(props.detox)
  props.disableInsight = JSON.parse(props.disableInsight)

  // attempt to install React Native or die trying
  const rnInstall = await reactNative.install({
    name,
    version: getReactNativeVersion(context)
  })
  if (rnInstall.exitCode > 0) process.exit(rnInstall.exitCode)

  // remove the __tests__ directory that come with React Native
  filesystem.remove('__tests__')
  filesystem.remove('App.js')

  props.name = name
  props.igniteVersion = ignite.version
  props.reactNativeVersion = rnInstall.version
  props.jhipsterDirectory = `../${props.jhipsterDirectory}`
  props.authType = jhipsterConfig['generator-jhipster'].authenticationType
  props.searchEngine = !!jhipsterConfig['generator-jhipster'].searchEngine
  props.websockets = !!jhipsterConfig['generator-jhipster'].websocket
  props.packageVersion = pkg.version
  await generateFiles(context, props, jhipsterConfig)

  /**
   * Merge the package.json from our template into the one provided from react-native init.
   */
  async function mergePackageJsons () {
    // transform our package.json incase we need to replace variables
    const rawJson = await template.generate({
      directory: `${ignite.ignitePluginPath()}/boilerplate`,
      template: 'package.json.ejs',
      props: props
    })
    const newPackageJson = JSON.parse(rawJson)

    // read in the react-native created package.json
    const currentPackage = filesystem.read('package.json', 'json')

    // deep merge, lol
    const newPackage = pipe(
      assoc(
        'dependencies',
        merge(currentPackage.dependencies, newPackageJson.dependencies)
      ),
      assoc(
        'devDependencies',
        merge(currentPackage.devDependencies, newPackageJson.devDependencies)
      ),
      assoc('scripts', merge(currentPackage.scripts, newPackageJson.scripts)),
      merge(
        __,
        omit(['dependencies', 'devDependencies', 'scripts'], newPackageJson)
      )
    )(currentPackage)

    // write this out
    filesystem.write('package.json', newPackage, { jsonIndent: 2 })
  }
  await mergePackageJsons()
  spinner.stop()
  spinner.succeed(`project generated`)

  if (!parameters.options.skipInstall) {
    spinner.text = `▸ installing dependencies`
    spinner.start()
    // install any missing dependencies
    await system.run('yarn', {stdio: 'ignore'})
    spinner.succeed(`dependencies installed`)
  }
  // pass long the debug flag if we're running in that mode
  // const debugFlag = parameters.options.debug ? '--debug' : ''

  /**
   * Append to files
   */
  // https://github.com/facebook/react-native/issues/12724
  filesystem.appendAsync('.gitattributes', '*.bat text eol=crlf')
  filesystem.append('.gitignore', 'coverage/')
  filesystem.append('.gitignore', '\n# Misc\n#')
  filesystem.append('.gitignore', '.env\n')
  filesystem.append('.gitignore', 'ios/Index/DataStore\n')
  filesystem.append('.gitignore', 'ios/Carthage\n')
  filesystem.append('.gitignore', 'ios/Pods\n')

  try {
    const ignitePluginConfigPath = `${__dirname}/ignite.json`
    const newConfig = filesystem.read(ignitePluginConfigPath, 'json')
    ignite.setIgnitePluginPath(__dirname)
    ignite.saveIgniteConfig(newConfig)

    fs.mkdirSync(`.jhipster`)
    fs.writeJsonSync('.jhipster/yo-rc.json', jhipsterConfig, { spaces: '\t' })
    print.success(`JHipster config saved to your app's .jhipster folder.`)
  } catch (e) {
    ignite.log(e)
    throw e
  }

  await patchReactNativeNavigation(context, props)

  // react native link -- must use spawn & stdio: ignore
  spinner.text = `▸ linking native libraries`
  spinner.start()
  await system.spawn('react-native link', { stdio: 'ignore' })
  let showCocoapodsInstructions = false
  if (props.authType === 'oauth2') {
    await system.spawn('react-native link react-native-app-auth', { stdio: 'ignore' })
    // if it's a mac
    if (process.platform === 'darwin') {
      // if cocoapods is installed, install the oauth dependencies
      const podVersionCommandResult = await system.spawn('pod --version', { stdio: 'ignore' })
      if (podVersionCommandResult.status === 0) {
        spinner.text = `▸ running pod install`
        await system.run('cd ios && pod install && cd ..', { stdio: 'ignore' })
        spinner.succeed(`pod install succeeded`)
      } else {
        showCocoapodsInstructions = true
      }
    }
  }
  spinner.succeed(`linked native libraries`)
  spinner.stop()

  // if JDL was passed to generate the app, generate any entities
  if (parameters.options.jdl) {
    await importEntityJdl(context)
  }

  // git configuration
  const gitExists = await filesystem.exists('./.git')
  if (!gitExists && !props.skipGit) {
    // initial git
    const spinner = print.spin('configuring git')

    try {
      await system.run(`git init . && git add . && git commit -m "Initial commit."`)
      spinner.succeed(`created a git repository and an initial commit`)
    } catch (e) {
      spinner.fail(`failed to create a git repository`)
    }
  }

  const perfDuration = parseInt(((new Date()).getTime() - perfStart) / 10) / 100
  spinner.succeed(`ignited ${print.colors.yellow(name)} in ${perfDuration}s`)

  Insight.trackAppOptions(context, props)

  // Wrap it up with our success message.
  print.info('')
  print.info('🍽 Time to get cooking!')
  print.info('')
  if (props.websockets) {
    print.info('To enable the websockets example, see https://github.com/ruddell/ignite-jhipster/blob/master/docs/websockets.md')
    print.info('')
  }
  if (props.authType === 'oauth2') {
    print.info(print.colors.bold(`Before iOS apps can be run, there are steps that must be complete manually`))
    if (showCocoapodsInstructions) {
      print.info(print.colors.blue(`Cocoapods not found, please install Cocooapods and run 'pod install' from your app's ios directory.`))
    }
    print.info('For more info on configuring OAuth2 OIDC Login, see https://github.com/ruddell/ignite-jhipster/blob/master/docs/oauth2-oidc.md')
    print.info('')
  }
  print.info('To run in iOS:')
  print.info(print.colors.bold(`  cd ${name}`))
  print.info(print.colors.bold('  react-native run-ios'))
  print.info('')
  if (isAndroidInstalled(context)) {
    print.info('To run in Android:')
  } else {
    print.info(`To run in Android, make sure you've followed the latest react-native setup instructions at https://facebook.github.io/react-native/docs/getting-started.html before using ignite.\nYou won't be able to run ${print.colors.bold('react-native run-android')} successfully until you have. Then:`)
  }
  print.info(print.colors.bold(`  cd ${name}`))
  print.info(print.colors.bold('  react-native run-android'))
  print.info('')
  print.info('To see what JHipster generators are available:')
  print.info(print.colors.bold(`  cd ${name}`))
  print.info(print.colors.bold('  ignite generate'))
  print.info('')
}

module.exports = {
  install
}
