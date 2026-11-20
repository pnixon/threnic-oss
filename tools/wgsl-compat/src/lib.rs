//! WGSL -> GLSL ES 3.00 translation for Threnic's WebGL2 compatibility backend.
//!
//! A thin C-ABI wrapper around naga (the shader translator Firefox and wgpu
//! use), built for `wasm32-unknown-unknown` with no JS glue: the host writes a
//! JSON request into memory from `wc_alloc`, calls `wc_translate`, and reads
//! back a length-prefixed JSON response which it releases with `wc_free`.
//!
//! Request:  { code, vertex?, fragment?, constants? }
//! Response: { ok: true, vertex?: Stage, fragment?: Stage }
//!         | { ok: false, stage, message, line?, column? }
//! Stage:    { glsl, uniforms: [{group, binding, name}],
//!             textures: [{name, group, binding, samplerGroup?, samplerBinding?}],
//!             firstInstance: bool }

use naga::back::glsl;
use naga::valid::{Capabilities, ValidationFlags, Validator};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
struct Request {
    code: String,
    vertex: Option<String>,
    fragment: Option<String>,
    #[serde(default)]
    constants: HashMap<String, f64>,
}

#[derive(Serialize)]
struct UniformOut {
    group: u32,
    binding: u32,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextureOut {
    name: String,
    group: u32,
    binding: u32,
    sampler_group: Option<u32>,
    sampler_binding: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageOut {
    glsl: String,
    uniforms: Vec<UniformOut>,
    textures: Vec<TextureOut>,
    first_instance: bool,
}

#[derive(Serialize, Default)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    vertex: Option<StageOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fragment: Option<StageOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
}

fn fail(stage: &'static str, message: String, loc: Option<naga::SourceLocation>) -> Response {
    Response {
        ok: false,
        stage: Some(stage),
        message: Some(message),
        line: loc.map(|l| l.line_number),
        column: loc.map(|l| l.line_position),
        ..Default::default()
    }
}

fn binding_of(module: &naga::Module, h: naga::Handle<naga::GlobalVariable>) -> (u32, u32) {
    match module.global_variables[h].binding {
        Some(ref b) => (b.group, b.binding),
        None => (u32::MAX, u32::MAX),
    }
}

fn write_stage(
    module: &naga::Module,
    info: &naga::valid::ModuleInfo,
    stage: naga::ShaderStage,
    entry: &str,
    constants: &HashMap<String, f64>,
) -> Result<StageOut, String> {
    let pc: naga::back::PipelineConstants =
        constants.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let (module, info) =
        naga::back::pipeline_constants::process_overrides(module, info, Some((stage, entry)), &pc)
            .map_err(|e| e.to_string())?;
    let options = glsl::Options {
        version: glsl::Version::new_gles(300),
        writer_flags: glsl::WriterFlags::ADJUST_COORDINATE_SPACE,
        binding_map: Default::default(),
        zero_initialize_workgroup_memory: false,
    };
    let pipeline = glsl::PipelineOptions {
        shader_stage: stage,
        entry_point: entry.to_string(),
        multiview: None,
    };
    let mut out = String::new();
    let mut writer = glsl::Writer::new(
        &mut out,
        &module,
        &info,
        &options,
        &pipeline,
        naga::proc::BoundsCheckPolicies::default(),
    )
    .map_err(|e| e.to_string())?;
    let reflection = writer.write().map_err(|e| e.to_string())?;

    let mut uniforms: Vec<UniformOut> = reflection
        .uniforms
        .iter()
        .map(|(h, name)| {
            let (group, binding) = binding_of(&module, *h);
            UniformOut { group, binding, name: name.clone() }
        })
        .collect();
    uniforms.sort_by_key(|u| (u.group, u.binding));
    let mut textures: Vec<TextureOut> = reflection
        .texture_mapping
        .iter()
        .map(|(name, m)| {
            let (group, binding) = binding_of(&module, m.texture);
            let s = m.sampler.map(|h| binding_of(&module, h));
            TextureOut {
                name: name.clone(),
                group,
                binding,
                sampler_group: s.map(|x| x.0),
                sampler_binding: s.map(|x| x.1),
            }
        })
        .collect();
    textures.sort_by(|a, b| a.name.cmp(&b.name));
    let first_instance = out.contains("naga_vs_first_instance");
    Ok(StageOut { glsl: out, uniforms, textures, first_instance })
}

fn translate(req: &Request) -> Response {
    let module = match naga::front::wgsl::parse_str(&req.code) {
        Ok(m) => m,
        Err(e) => return fail("parse", e.message().to_string(), e.location(&req.code)),
    };
    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
    let info = match validator.validate(&module) {
        Ok(i) => i,
        Err(e) => {
            let loc = e.location(&req.code);
            let mut msg = e.as_inner().to_string();
            let mut source = std::error::Error::source(e.as_inner());
            while let Some(s) = source {
                msg.push_str(": ");
                msg.push_str(&s.to_string());
                source = s.source();
            }
            return fail("validate", msg, loc);
        }
    };
    let mut res = Response { ok: true, ..Default::default() };
    if let Some(ref ep) = req.vertex {
        match write_stage(&module, &info, naga::ShaderStage::Vertex, ep, &req.constants) {
            Ok(s) => res.vertex = Some(s),
            Err(m) => return fail("vertex", m, None),
        }
    }
    if let Some(ref ep) = req.fragment {
        match write_stage(&module, &info, naga::ShaderStage::Fragment, ep, &req.constants) {
            Ok(s) => res.fragment = Some(s),
            Err(m) => return fail("fragment", m, None),
        }
    }
    res
}

#[no_mangle]
pub extern "C" fn wc_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len.max(1)].into_boxed_slice()) as *mut u8
}

/// # Safety
/// `ptr`/`len` must come from `wc_alloc(len)`, or be a response buffer from
/// `wc_translate` (in which case `len` is the JSON length + 4).
#[no_mangle]
pub unsafe extern "C" fn wc_free(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len.max(1))));
}

/// # Safety
/// `ptr`/`len` must describe a UTF-8 JSON request written by the host.
/// Returns a buffer of `[u32 little-endian length][JSON bytes]`.
#[no_mangle]
pub unsafe extern "C" fn wc_translate(ptr: *const u8, len: usize) -> *mut u8 {
    let input = std::slice::from_raw_parts(ptr, len);
    let res = match serde_json::from_slice::<Request>(input) {
        Ok(req) => translate(&req),
        Err(e) => fail("request", e.to_string(), None),
    };
    let json = serde_json::to_vec(&res).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let mut out = Vec::<u8>::with_capacity(json.len() + 4);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    Box::into_raw(out.into_boxed_slice()) as *mut u8
}
