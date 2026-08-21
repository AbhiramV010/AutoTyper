cmake_minimum_required(VERSION 3.16)
project(AutoTyperInstaller CXX)

if (NOT WIN32)
    message(FATAL_ERROR "This installer targets Windows only.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(AutoTyperInstaller main.cpp)
target_compile_definitions(AutoTyperInstaller PRIVATE UNICODE _UNICODE)

target_link_libraries(AutoTyperInstaller PRIVATE
    shell32
    ole32
    advapi32
    uuid
)

if (MINGW)
    target_link_options(AutoTyperInstaller PRIVATE -municode)
endif()
