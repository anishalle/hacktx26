Pod::Spec.new do |s|
  s.name = 'ChimeCall'
  s.version = '1.0.0'
  s.summary = 'Local Expo bridge to the Amazon Chime iOS SDK'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'HackTX team'
  s.homepage = 'https://github.com/anishalle/hacktx26'
  s.source = { :git => s.homepage }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.dependency 'AmazonChimeSDK', '0.27.4'
end
