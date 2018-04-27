#! /usr/bin/env node

'use strict'

const compile = require('@lingui/cli/api/compile')
const commander = require('commander')
const extract = require('@lingui/cli/api/extract')
const tmp = require('tmp')

const path = require('path')
const fs = require('fs')

// Set up version command
commander.version(require('../package.json').version)

// Set up extract command
commander.command('extract [packageFile] [localesDirectory]').action((packageFile = './package.json', localesDir = './locale') => {
  try {
    const packageObject = loadPackageConfig(packageFile)

    const locales = loadLocales(localesDir)

    extractCatalogs(packageFile, packageObject, localesDir, locales)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
})

// Set up compile command
commander.command('compile [packageFile] [localesDirectory]').option('-s, --strict', 'Strict compilation').action(function (packageFile = './package.json', localesDir = './locale', args = {}) {
  try {
    // 1. Load the config from package.json
    // 2. Validate the configuration
    // 3. Inject a special sub-catalog bundle so that a complete
    //    catalog is generated alongside the sub-catalogs
    var packageObject = loadPackageConfig(packageFile)

    var locales = loadLocales(localesDir)

    compileCatalogs(packageFile, packageObject, localesDir, locales, args)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
})

function extractCatalogs (packageFile, packageObject, localesDir, locales) {
  // The directory where we are going to do the extract/collect
  const targetDir = createTempDirectory()

  let options = Object.assign({}, packageObject.lingui, { srcPathDirs: packageObject.lingui.srcPathDirs.map(srcPath => srcPath.replace('<rootDir>', path.dirname(packageFile))), ignore: packageObject.lingui.srcPathIgnorePatterns || [] })

  extract.extract(options.srcPathDirs, targetDir, options)

  const rawCatalog = extract.collect(targetDir)

  // Prepopulate with empty translations
  const linguiCatalog = Object.keys(rawCatalog).reduce((final, key) => Object.assign(final, { [key]: Object.assign({ translation: '' }, rawCatalog[key]) }), {})

  // Go over each locale
  locales.forEach((locale) => {
    // Just ignore the build directory if it pops up by mistake.
    if (locale === '_build') return

    // Only continue if locale is a directory
    if (fs.lstatSync(path.resolve(localesDir, locale)).isDirectory() === false) {
      return
    }

    const translationOnlyCatalog = filterTranslationOnly(loadLinguiCatalog(localesDir, locale))
    const complexCatalog = Object.keys(linguiCatalog).reduce((finalCatalog, translationKey) => Object.assign(finalCatalog, { [translationKey]: Object.assign(linguiCatalog[translationKey], translationOnlyCatalog[translationKey]) }), {})

    const minimalCatalog = Object.assign(createMinimalCatalog(complexCatalog), loadMinimalCatalogBypassErrors(localesDir, locale))

    writeCatalogs(complexCatalog, minimalCatalog, localesDir, locale)
    console.info(`${locale} ${Object.keys(minimalCatalog).length}`)
  })
}

function compileCatalogs (packageFile, packageObject, localesDir, locales, args) {
  // Iterate the language catalogs
  Object.keys(packageObject['lingui-multi']).forEach(catalogName => {
    console.info(`\n\nCatalog: ${catalogName}`)
    console.info('================')

    // Grab the ignore patterns
    const ignorePattern = getSubCatalogIgnoreRegex(packageObject, catalogName)

    // Go over each locale
    locales.forEach(function (locale) {
      // Just ignore the build directory if it pops up by mistake.
      if (locale === '_build') return

      // Only continue if locale is a directory
      if (fs.lstatSync(path.resolve(localesDir, locale)).isDirectory() === false) {
        return
      }

      const messagesObject = loadLinguiCatalog(localesDir, locale)

      const screenedKeys = Object.keys(messagesObject).filter(key => messagesObject[key].origin.every(
        origin => ignorePattern && ignorePattern.test(origin[0]) === false))

      // Grab hold of the minimal format catalog
      const minimalCatalogObject = loadMinimalCatalog(localesDir, locale)

      if (args.strict && 'sourceLocale' in packageObject.lingui && locale !== packageObject.lingui.sourceLocale) {
        verifyNoMissingTranslations(minimalCatalogObject, locale)
      }

      // Pull out translations of interest
      const screenedCatalogObject = screenedKeys.reduce((final, key) =>
        key in minimalCatalogObject ? Object.assign(final, { [key]: minimalCatalogObject[key] }) : final, {})

      // Compile the catalog js data
      const jsData = compile.createCompiledCatalog(locale, screenedCatalogObject)

      // Catalog: __lingui-multi is for complete catalog
      const targetFile = catalogName === '__lingui-multi' ? getCatalogTagetFilePath(localesDir, locale) : getSubCatalogTargetFilePath(localesDir, locale, catalogName)

      fs.writeFileSync(targetFile, jsData)

      console.info(`${locale} ${Object.keys(screenedCatalogObject).length}`)
    })
  })
}

function loadPackageConfig (filename) {
  if (fs.existsSync(filename) === false) {
    throw new Error('package.json does not exist')
  }

  try {
    const parsedConfig = JSON.parse(fs.readFileSync(filename))

    // Validate the config and then inject main
    // catalog settings so that a complete catalog
    // is generated alongside sub-catalogs, then
    // return the resulting configuration object
    return injectMainCatalogConfig(validatePackageConfig(parsedConfig))
  } catch (error) {
    throw new Error('package.json is not a valid JSON file')
  }
}

function validatePackageConfig (config) {
  if (!('lingui' in config)) {
    throw new Error('no lingui config found')
  }

  if (!('sourceLocale' in config.lingui)) {
    throw new Error('no source locale in lingui config')
  }

  if (!('lingui-multi' in config)) {
    throw new Error('no lingui-multi config found')
  }

  if (Object.keys(config['lingui-multi']).length === 0) {
    throw new Error('no lingui-multi sub-catalog config found')
  }

  return config
}

function injectMainCatalogConfig (config) {
  return Object.assign({}, config, { 'lingui-multi': Object.assign(config['lingui-multi'], { '__lingui-multi': {} }) })
}

function loadLocales (directory) {
  if (fs.existsSync(directory) === false) {
    throw new Error('locale directory does not exist')
  }

  return fs.readdirSync(directory)
}

function getSubCatalogIgnoreRegex (config, catalogName) {
  const ignorePatterns = [].concat(config.lingui.srcPathIgnorePatterns || [], config['lingui-multi'][catalogName].srcPathIgnorePatterns || [])

  return ignorePatterns.length ? new RegExp(ignorePatterns.join('|'), 'i') : null
}

function loadMinimalCatalog (directory, locale) {
  return _loadCatalog(directory, locale)
}

function loadMinimalCatalogBypassErrors (directory, locale) {
  try {
    return _loadCatalog(directory, locale)
  } catch (error) {
    return {}
  }
}

function loadLinguiCatalog (directory, locale) {
  try {
    return _loadCatalog(directory, locale, '.metadata')
  } catch (error) {
    return {}
  }
}

function _loadCatalog (directory, locale, suffix) {
  const filePath = _getJsonFilePath(directory, locale, suffix)

  try {
    return Object.assign({}, JSON.parse(fs.readFileSync(filePath)))
  } catch (error) {
    throw new Error(`file is corrupted: ${filePath}`)
  }
}

function verifyNoMissingTranslations (catalog, locale) {
  const missingTranslations = Object.keys(catalog).filter(key => catalog[key] === '')

  if (missingTranslations.length > 0) {
    throw new Error(`Missing ${missingTranslations.length} translations in ${locale}`)
  }
}

function createTempDirectory () {
  return tmp.dirSync().name
}

function getCatalogTagetFilePath (directory, locale) {
  return _getTargetFilePath(directory, locale)
}

function getSubCatalogTargetFilePath (directory, locale, catalogName) {
  return _getTargetFilePath(directory, locale, `${catalogName}.`)
}

function _getTargetFilePath (directory, locale, prefix = '') {
  return `${directory}/${locale}/${prefix}messages.js`
}

function _getJsonFilePath (directory, locale, suffix = '') {
  let jsonFile = `${directory}/${locale}/messages${suffix}.json`
  if (fs.existsSync(jsonFile) === false) {
    throw new Error(`file missing: ${jsonFile}`)
  }
  return jsonFile
}

function createMinimalCatalog (complexCatalog) {
  return Object.keys(complexCatalog).reduce((final, key) =>
    Object.assign(final, { [key]: complexCatalog[key].translation }), {})
}

function writeCatalogs (complex, minimal, directory, locale) {
  const targetComplexFile = `${directory}/${locale}/messages.metadata.json`
  const targetMinimalFile = `${directory}/${locale}/messages.json`

  const occuranceLocationsRemoved = _removeOccuranceLineNumbers(complex)

  fs.writeFileSync(targetComplexFile, JSON.stringify(occuranceLocationsRemoved, null, 2))
  fs.writeFileSync(targetMinimalFile, JSON.stringify(minimal, null, 2))
}

function filterProperties (obj, properties) {
  return Object.keys(obj).filter(key => properties.includes(key)).reduce((final, filteredKey) => Object.assign(final, { [filteredKey]: obj[filteredKey] }), {})
}

function filterTranslationOnly (catalog) {
  return Object.keys(catalog).reduce((finalCatalog, translationKey) => Object.assign(finalCatalog, { [translationKey]: filterProperties(catalog[translationKey], ['translation']) }), {})
}

function _removeOccuranceLineNumbers (complexCatalog) {
  const keys = Object.keys(complexCatalog)
  return keys.reduce((redactedCatalog, key) => Object.assign(redactedCatalog, { [key]: Object.assign(complexCatalog[key], { origin: complexCatalog[key].origin.map(origin => origin.filter((element, idx) => idx === 0)) }) }), {})
}

module.exports = {
  loadLinguiCatalog,
  loadMinimalCatalog,
  _loadCatalog,
  _getTargetFilePath,
  _getJsonFilePath,
  loadPackageConfig,
  verifyNoMissingTranslations,
  createMinimalCatalog,
  validatePackageConfig
}

commander.parse(process.argv)
