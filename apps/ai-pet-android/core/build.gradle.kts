plugins { kotlin("jvm") }
kotlin { jvmToolchain(17) }
val prepareSharedFixtures by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("node", "scripts/prepare-shared-fixtures.mjs")
}
val coreTest by tasks.registering(JavaExec::class) {
    dependsOn(tasks.testClasses, prepareSharedFixtures)
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("com.keepwork.aipet.core.CoreTestKt")
}
tasks.check { dependsOn(coreTest) }
