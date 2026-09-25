"""Contained starter projects with no global SDK dependency."""
from __future__ import annotations

import re
from pathlib import Path

from .env_manager import EnvironmentManager


TEMPLATES = {"java", "kotlin", "android"}


class ProjectTemplates:
    def __init__(self, env: EnvironmentManager):
        self.env = env

    def create(self, kind: str, name: str, package: str = "dev.unum.app") -> dict:
        if kind not in TEMPLATES:
            raise ValueError("Unknown project template")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{1,60}", name):
            raise ValueError("Invalid project name")
        if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", package):
            raise ValueError("Invalid package name")
        root = self.env.project_path(name)
        if root.exists():
            raise ValueError("Project path already exists")
        package_path = package.replace(".", "/")
        files: dict[str, str]
        if kind == "java":
            files = {
                "pom.xml": f"<project xmlns=\"http://maven.apache.org/POM/4.0.0\"><modelVersion>4.0.0</modelVersion><groupId>{package}</groupId><artifactId>{name}</artifactId><version>1.0.0</version><properties><maven.compiler.release>21</maven.compiler.release></properties></project>\n",
                f"src/main/java/{package_path}/Main.java": f"package {package};\n\npublic class Main {{\n    public static void main(String[] args) {{\n        System.out.println(\"Hello from Unum\");\n    }}\n}}\n",
            }
        elif kind == "kotlin":
            files = {
                "settings.gradle.kts": f'rootProject.name = "{name}"\n',
                "build.gradle.kts": 'plugins { kotlin("jvm") version "2.0.21" application }\nrepositories { mavenCentral() }\napplication { mainClass.set("MainKt") }\nkotlin { jvmToolchain(21) }\n',
                "src/main/kotlin/Main.kt": 'fun main() {\n    println("Hello from Unum")\n}\n',
            }
        else:
            files = {
                "settings.gradle.kts": f'pluginManagement {{ repositories {{ google(); mavenCentral(); gradlePluginPortal() }} }}\ndependencyResolutionManagement {{ repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories {{ google(); mavenCentral() }} }}\nrootProject.name = "{name}"\ninclude(":app")\n',
                "build.gradle.kts": 'plugins { id("com.android.application") version "8.7.3" apply false; id("org.jetbrains.kotlin.android") version "2.0.21" apply false }\n',
                "app/build.gradle.kts": f'plugins {{ id("com.android.application"); id("org.jetbrains.kotlin.android") }}\nandroid {{ namespace = "{package}"; compileSdk = 34\n defaultConfig {{ applicationId = "{package}"; minSdk = 24; targetSdk = 34; versionCode = 1; versionName = "1.0" }} }}\n',
                "app/src/main/AndroidManifest.xml": f'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="{name}" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name=".{"MainActivity"}" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>\n',
                f"app/src/main/java/{package_path}/MainActivity.kt": f'package {package}\n\nimport android.app.Activity\nimport android.os.Bundle\nimport android.widget.TextView\n\nclass MainActivity : Activity() {{\n    override fun onCreate(savedInstanceState: Bundle?) {{\n        super.onCreate(savedInstanceState)\n        setContentView(TextView(this).apply {{ text = "Hello from Unum" }})\n    }}\n}}\n',
                "local.properties.example": "# Copy to local.properties and set sdk.dir to the workspace local Android SDK.\n",
            }
        for relative, content in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return {"path": str(root.relative_to(self.env.workspace)), "files": list(files)}
